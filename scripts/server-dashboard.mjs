import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile, rename, unlink, writeFile } from "node:fs/promises";
import { isIP } from "node:net";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs, promisify } from "node:util";

class DashboardError extends Error {
  constructor(code) { super(code); this.code = code; }
}

/** IDs are data, never shell fragments or arbitrary URL paths. */
function messageId(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(value)) throw new DashboardError("MESSAGE_ID_INVALID");
  return value;
}

function configuration() {
  const project = process.env.RIMO_COMPOSE_PROJECT ?? "rimo";
  if (!/^[a-z0-9][a-z0-9_-]{0,62}$/.test(project)) throw new DashboardError("PROJECT_INVALID");
  const directory = path.resolve(process.env.RIMO_OPERATOR_PRIVATE_DIR ?? "/srv/rimo/private");
  return { project, tokenFile: path.join(directory, "ntfy-agent-token"), cursorFile: path.join(directory, "ntfy-inbox-cursor.json") };
}

async function cursor(filename) {
  let text;
  try { text = await readFile(filename, "utf8"); }
  catch (error) { if (error.code === "ENOENT") return "all"; throw new DashboardError("CURSOR_UNAVAILABLE"); }
  try { return messageId(JSON.parse(text).lastMessageId); }
  catch { throw new DashboardError("CURSOR_INVALID"); }
}

async function acknowledge(filename, id) {
  const temporary = `${filename}.pending-${randomUUID()}`;
  try {
    await writeFile(temporary, `${JSON.stringify({ lastMessageId: messageId(id), acknowledgedAt: new Date().toISOString() })}\n`, { mode: 0o600, flag: "wx" });
    await rename(temporary, filename);
  } finally { await unlink(temporary).catch((error) => { if (error.code !== "ENOENT") throw error; }); }
  return { status: "acknowledged", id };
}

/** Resolve only Docker's private bridge address; do not inspect Config.Env. */
async function privateOrigin(project, inspect) {
  const result = await inspect("docker", ["inspect", "--format",
    "{{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}", `${project}-ntfy-1`],
  { timeout: 5_000, maxBuffer: 4_096, windowsHide: true });
  const addresses = result.stdout.trim().split(/\s+/);
  if (addresses.length !== 1 || isIP(addresses[0]) !== 4) throw new DashboardError("PRIVATE_ADDRESS_INVALID");
  const [first, second] = addresses[0].split(".").map(Number);
  if (!(first === 10 || first === 127 || (first === 172 && second >= 16 && second <= 31) ||
      (first === 192 && second === 168))) throw new DashboardError("PRIVATE_ADDRESS_REQUIRED");
  return `http://${addresses[0]}:8080`;
}

/** Never expose transport exceptions or server error bodies, which may contain secrets. */
async function request(origin, resource, token, payload, transport) {
  const response = await transport(new URL(resource, origin), {
    method: payload ? "POST" : "GET", redirect: "manual", signal: AbortSignal.timeout(10_000),
    headers: { Authorization: `Bearer ${token}`, ...(payload ? { "Content-Type": "application/json" } : {}) },
    ...(payload ? { body: JSON.stringify(payload) } : {}),
  });
  let size = 0;
  const chunks = [];
  for await (const chunk of response.body ?? []) {
    size += chunk.byteLength;
    if (size > 512 * 1_024) throw new DashboardError("RESPONSE_TOO_LARGE");
    chunks.push(chunk);
  }
  if (!response.ok) throw new DashboardError(`HTTP_${response.status}`);
  const truncated = response.headers.get("X-Messages-Truncated")?.trim().toLowerCase();
  if (truncated && !["false", "0"].includes(truncated)) throw new DashboardError("INBOX_TRUNCATED_DO_NOT_ACK");
  return Buffer.concat(chunks).toString("utf8");
}

async function publish(filename, origin, token, transport) {
  let payload;
  try { payload = JSON.parse(await readFile(filename, "utf8")); }
  catch { throw new DashboardError("PUBLISH_INPUT_INVALID"); }
  if (!payload || Array.isArray(payload) || typeof payload !== "object" ||
      Object.keys(payload).some((key) => !["title", "message", "tags"].includes(key)) ||
      typeof payload.message !== "string" || !payload.message.trim() || Buffer.byteLength(payload.message) > 4_096 ||
      (payload.title !== undefined && (typeof payload.title !== "string" || Buffer.byteLength(payload.title) > 256)) ||
      (payload.tags !== undefined && (!Array.isArray(payload.tags) || payload.tags.length > 8 ||
        payload.tags.some((tag) => typeof tag !== "string" || !/^[A-Za-z0-9_+-]{1,64}$/.test(tag))))) {
    throw new DashboardError("PUBLISH_INPUT_INVALID");
  }
  const text = await request(origin, "/", token, { topic: "rimo-work", ...payload }, transport);
  let message;
  try { message = JSON.parse(text); }
  catch { throw new DashboardError("PUBLISH_RESPONSE_INVALID"); }
  return { status: "published", id: messageId(message.id) };
}

async function poll(filename, origin, token, transport) {
  const since = await cursor(filename);
  const query = new URLSearchParams({ poll: "1", since });
  const text = await request(origin, `/rimo-inbox/json?${query}`, token, undefined, transport);
  const messages = [];
  const seen = new Set();
  try {
    for (const line of text.split(/\r?\n/).filter((value) => value.trim())) {
      const row = JSON.parse(line);
      if (row.event !== "message") continue;
      const id = messageId(row.id);
      if (!Number.isSafeInteger(row.time) || row.time < 0 || typeof row.message !== "string" ||
          (row.title !== undefined && typeof row.title !== "string")) throw new Error("Invalid message");
      if (seen.has(id)) continue;
      seen.add(id);
      messages.push({ id, time: row.time, title: row.title ?? "", message: row.message });
    }
  } catch { throw new DashboardError("INBOX_RESPONSE_INVALID_DO_NOT_ACK"); }
  return { status: "read", since, messages };
}

async function perform(args, { inspect = promisify(execFile), transport = fetch } = {}) {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, strict: true,
    options: { "input-file": { type: "string" }, id: { type: "string" }, help: { type: "boolean" } } });
  if (values.help) {
    process.stdout.write("server-dashboard.mjs publish --input-file FILE | poll | ack --id ID\nRun on the server. Poll never advances the cursor; acknowledge only after processing in order.\n");
    return;
  }
  const [action] = positionals;
  if (positionals.length !== 1 || !["publish", "poll", "ack"].includes(action) ||
      (action === "publish" && (!values["input-file"] || values.id)) ||
      (action === "ack" && (!values.id || values["input-file"])) ||
      (action === "poll" && (values.id || values["input-file"]))) throw new DashboardError("OPTIONS_INVALID");
  const config = configuration();
  let result;
  if (action === "ack") result = await acknowledge(config.cursorFile, values.id);
  else {
    const token = (await readFile(config.tokenFile, "utf8")).trim();
    if (!/^tk_[A-Za-z0-9_-]{10,256}$/.test(token)) throw new DashboardError("TOKEN_INVALID");
    const origin = await privateOrigin(config.project, inspect);
    result = action === "publish" ? await publish(values["input-file"], origin, token, transport) : await poll(config.cursorFile, origin, token, transport);
  }
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

/** Dependency injection is for isolated checks, never exposed as CLI configuration. */
export async function main(args = process.argv.slice(2), dependencies = {}) {
  try { await perform(args, dependencies); }
  catch (error) { throw error instanceof DashboardError ? error : new DashboardError("DASHBOARD_OPERATION_FAILED"); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    process.stderr.write(`${JSON.stringify({ status: "failed", code: error instanceof DashboardError ? error.code : "DASHBOARD_OPERATION_FAILED" })}\n`);
    process.exitCode = 1;
  });
}
