import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { main } from "./server-dashboard.mjs";

const temporaryRoot = fileURLToPath(new URL("../temp/", import.meta.url));
await mkdir(temporaryRoot, { recursive: true });
const prefix = "dashboard-client-check-";
const directory = await mkdtemp(path.join(temporaryRoot, prefix));
// Deliberately synthetic markers: no real account, token, Docker or VPS is used.
const testToken = "tk_SYNTHETIC_TEST_ONLY_1234567890";
const responseSecret = "SYNTHETIC_RESPONSE_SECRET_MUST_NOT_LEAK";
const cursor = path.join(directory, "ntfy-inbox-cursor.json");
const input = path.join(directory, "progress.json");
const originalDirectory = process.env.RIMO_OPERATOR_PRIVATE_DIR;
const originalProject = process.env.RIMO_COMPOSE_PROJECT;
const messages = [
  { event: "message", id: "first1", time: 1, title: "Первое", message: "$(touch NEVER_EXECUTE)", token: responseSecret },
  { event: "message", id: "second2", time: 2, message: "Второе" },
];
const seenSince = [];
const serverErrors = [];
let mode = "normal";
let inspected = 0;
let passed = 0;

const server = createServer(async (request, response) => {
  try {
    assert.equal(request.headers.authorization, `Bearer ${testToken}`);
    if (mode === "http-error") { response.writeHead(503); response.end(JSON.stringify({ token: testToken })); return; }
    if (mode === "too-large") { response.end("x".repeat(512 * 1_024 + 1)); return; }
    if (mode === "truncated") response.setHeader("X-Messages-Truncated", "true");
    if (request.method === "POST") {
      let body = ""; for await (const chunk of request) body += chunk;
      const payload = JSON.parse(body);
      assert.equal(payload.topic, "rimo-work"); assert.match(payload.message, /touch NEVER_EXECUTE/);
      response.end(JSON.stringify({ id: "published3", event: "message", token: testToken }));
      return;
    }
    const url = new URL(request.url, "http://localhost");
    assert.equal(url.pathname, "/rimo-inbox/json"); assert.equal(url.searchParams.get("poll"), "1");
    const since = url.searchParams.get("since"); seenSince.push(since);
    if (mode === "malformed") { response.end('{"event":"message","id":"bad id"}'); return; }
    const result = since === "first1" ? [messages[1]] : [messages[0], messages[0], messages[1]];
    response.end([{ event: "open", token: testToken }, ...result].map((message) => JSON.stringify(message)).join("\n"));
  } catch (error) {
    serverErrors.push(error);
    response.writeHead(500); response.end("MOCK_ASSERTION_FAILED");
  }
});

const dependencies = {
  inspect: async (command, args, options) => {
    inspected += 1;
    assert.equal(command, "docker");
    assert.deepEqual(args, ["inspect", "--format", "{{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}", "rimo-ntfy-1"]);
    assert.equal(options.timeout, 5_000);
    return { stdout: "172.28.0.5 \n" };
  },
  transport: (url, options) => {
    assert.equal(url.origin, "http://172.28.0.5:8080"); assert.equal(options.redirect, "manual");
    assert.ok(options.signal instanceof AbortSignal);
    const redirected = new URL(url);
    redirected.hostname = "127.0.0.1"; redirected.port = String(server.address().port);
    return fetch(redirected, options);
  },
};

async function invoke(args, injected = dependencies) {
  let output = "";
  const write = process.stdout.write;
  process.stdout.write = (chunk) => { output += chunk; return true; };
  try { await main(args, injected); return JSON.parse(output); }
  finally {
    process.stdout.write = write;
    assert.ok(!output.includes(testToken) && !output.includes(responseSecret), "Synthetic secret reached stdout");
  }
}

async function rejected(args, code, injected = dependencies) {
  await assert.rejects(() => invoke(args, injected), (error) => {
    assert.equal(error.message, code); assert.ok(!String(error.stack).includes(testToken)); return true;
  });
}

try {
  process.env.RIMO_OPERATOR_PRIVATE_DIR = directory;
  process.env.RIMO_COMPOSE_PROJECT = "rimo";
  await writeFile(path.join(directory, "ntfy-agent-token"), testToken);
  await writeFile(input, JSON.stringify({ title: "Проверка", message: "Текст $(touch NEVER_EXECUTE) <script>no execution</script>", tags: ["white_check_mark"] }));
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve(); });
  });
  assert.deepEqual(await invoke(["publish", "--input-file", input]), { status: "published", id: "published3" }); passed++;
  const first = await invoke(["poll"]);
  assert.equal(first.messages.length, 2); assert.deepEqual(Object.keys(first.messages[0]), ["id", "time", "title", "message"]); passed++;
  assert.equal((await invoke(["poll"])).messages.length, 2); assert.deepEqual(seenSince.slice(0, 2), ["all", "all"]); passed++;
  await assert.rejects(readFile(cursor), { code: "ENOENT" }); passed++;
  await invoke(["ack", "--id", "first1"]); assert.equal(JSON.parse(await readFile(cursor, "utf8")).lastMessageId, "first1"); passed++;
  assert.deepEqual((await invoke(["poll"])).messages.map((row) => row.id), ["second2"]); passed++;
  const before = await readFile(cursor, "utf8");
  mode = "truncated"; await rejected(["poll"], "INBOX_TRUNCATED_DO_NOT_ACK"); assert.equal(await readFile(cursor, "utf8"), before); passed++;
  mode = "too-large"; await rejected(["poll"], "RESPONSE_TOO_LARGE"); assert.equal(await readFile(cursor, "utf8"), before); passed++;
  mode = "malformed"; await rejected(["poll"], "INBOX_RESPONSE_INVALID_DO_NOT_ACK"); passed++;
  mode = "http-error"; await rejected(["poll"], "HTTP_503"); passed++;
  mode = "normal";
  await rejected(["poll"], "PRIVATE_ADDRESS_REQUIRED", { ...dependencies, inspect: async () => ({ stdout: "8.8.8.8" }) }); passed++;
  await rejected(["poll"], "PRIVATE_ADDRESS_INVALID", { ...dependencies, inspect: async () => ({ stdout: "172.28.0.5 172.29.0.5" }) }); passed++;
  const beforeInvalid = inspected; process.env.RIMO_COMPOSE_PROJECT = "rimo; echo unsafe";
  await rejected(["poll"], "PROJECT_INVALID"); assert.equal(inspected, beforeInvalid); process.env.RIMO_COMPOSE_PROJECT = "rimo"; passed++;
  await rejected(["ack", "--id", "../../bad"], "MESSAGE_ID_INVALID"); assert.equal(await readFile(cursor, "utf8"), before); passed++;
  await rejected(["poll"], "DASHBOARD_OPERATION_FAILED", { ...dependencies, transport: async () => { throw new Error(testToken); } }); passed++;
  await writeFile(input, JSON.stringify({ message: "wrong topic", topic: "rimo-inbox" }));
  await rejected(["publish", "--input-file", input], "PUBLISH_INPUT_INVALID"); passed++;
  assert.ok(!(await readdir(directory)).some((name) => name.includes("pending") || name.includes("NEVER_EXECUTE")));
  assert.deepEqual(serverErrors, []); passed++;
} finally {
  try {
    if (server.listening) {
      const closed = new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      server.closeAllConnections();
      await closed;
    }
  } finally {
    if (originalDirectory === undefined) delete process.env.RIMO_OPERATOR_PRIVATE_DIR; else process.env.RIMO_OPERATOR_PRIVATE_DIR = originalDirectory;
    if (originalProject === undefined) delete process.env.RIMO_COMPOSE_PROJECT; else process.env.RIMO_COMPOSE_PROJECT = originalProject;
    const resolved = await realpath(directory);
    assert.equal(path.dirname(resolved), await realpath(temporaryRoot));
    assert.ok(path.basename(resolved).startsWith(prefix));
    await rm(resolved, { recursive: true });
  }
}

process.stdout.write(`${JSON.stringify({ passed, network: "loopback-only", realDockerCalls: 0, tokenLeaked: false, temporaryFilesRemoved: true })}\n`);
