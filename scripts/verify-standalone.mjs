import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import { createServer } from "node:net";
import path from "node:path";

const directory = path.resolve(".next/standalone");
const endpoints = [
  { key: "COLLABORATION_PUBLIC_URL", value: "wss://first.example.test/collaboration" },
  { key: "COLLABORATION_PUBLIC_URL", value: "wss://second.example.test/collaboration" },
  { key: "NEXT_PUBLIC_COLLABORATION_URL", value: "wss://legacy.example.test/collaboration" },
];

async function freePort() {
  const server = createServer();
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return address.port;
}

async function waitUntilReady(origin, child) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    assert.equal(child.exitCode, null, "Standalone exited during startup");
    if (await fetch(`${origin}/api/health`, { signal: AbortSignal.timeout(1000) }).then((response) => response.ok).catch(() => false)) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Standalone did not become ready");
}

async function stop(child, closed) {
  if (child.exitCode === null) child.kill("SIGTERM");
  const timer = setTimeout(() => { if (child.exitCode === null) child.kill("SIGKILL"); }, 5_000);
  try { await closed; } finally { clearTimeout(timer); }
}

async function verifyEndpoint(endpoint, email, password, buildId) {
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const environment = { ...process.env, PORT: String(port), HOSTNAME: "127.0.0.1", BETTER_AUTH_URL: origin };
  delete environment.COLLABORATION_PUBLIC_URL;
  delete environment.NEXT_PUBLIC_COLLABORATION_URL;
  environment[endpoint.key] = endpoint.value;
  const child = spawn(process.execPath, ["scripts/start.mjs"], {
    env: environment, stdio: ["ignore", "ignore", "ignore"], shell: false, windowsHide: true,
  });
  const closed = new Promise((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
  let boardId;
  let cookie;
  try {
    await waitUntilReady(origin, child);
    const login = await fetch(`${origin}/api/auth/sign-in/email`, {
      method: "POST", headers: { origin, "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }), signal: AbortSignal.timeout(10_000),
    });
    assert.equal(login.status, 200, "Standalone owner sign-in failed");
    cookie = login.headers.getSetCookie().map((value) => value.split(";")[0]).join("; ");
    assert.ok(cookie, "Standalone sign-in did not set a session");
    const created = await fetch(`${origin}/api/boards`, {
      method: "POST", headers: { cookie, origin, "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Standalone runtime fixture" }), signal: AbortSignal.timeout(5_000),
    });
    assert.equal(created.status, 201, "Standalone board creation failed");
    boardId = (await created.json()).board.id;
    assert.match(boardId, /^[a-f0-9-]{36}$/, "Unexpected standalone fixture ID");
    const response = await fetch(`${origin}/api/boards/${boardId}/session`, {
      headers: { cookie }, signal: AbortSignal.timeout(5_000),
    });
    assert.equal(response.status, 200, "Standalone board session failed");
    assert.ok((await response.json()).connection.url === endpoint.value, "Compiled application ignored its runtime endpoint");
    assert.equal((await readFile(path.join(directory, ".next/BUILD_ID"), "utf8")).trim(), buildId);
  } finally {
    try {
      if (boardId && cookie) {
        const deleted = await fetch(`${origin}/api/boards/${boardId}`, {
          method: "DELETE", headers: { cookie, origin }, signal: AbortSignal.timeout(5_000),
        });
        assert.ok(deleted.ok, "Standalone fixture cleanup failed");
      }
    } finally { await stop(child, closed); }
  }
}

async function main() {
  const email = process.env.RIMO_E2E_EMAIL;
  const password = process.env.RIMO_E2E_PASSWORD;
  assert.ok(email && password, "Set RIMO_E2E_EMAIL and RIMO_E2E_PASSWORD for a dedicated test owner");
  const resources = [
    "@fontsource/noto-sans/files/noto-sans-cyrillic-400-normal.woff2",
    "@fontsource/noto-serif/files/noto-serif-cyrillic-700-italic.woff2",
    "@fontsource/noto-sans-mono/files/noto-sans-mono-latin-400-normal.woff2",
    "katex/dist/katex.min.css", "katex/dist/fonts/KaTeX_Main-Regular.woff2",
  ];
  await Promise.all(resources.map((file) => access(path.join(directory, "node_modules", file))));
  const buildId = (await readFile(path.join(directory, ".next/BUILD_ID"), "utf8")).trim();
  for (const endpoint of endpoints) await verifyEndpoint(endpoint, email, password, buildId);
  process.stdout.write(`${JSON.stringify({ result: "passed", buildId, resourceChecks: resources.length,
    runtimeEndpoints: endpoints.length, rebuildsBetweenEndpoints: 0 })}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : "Standalone verification failed"}\n`);
  process.exitCode = 1;
});
