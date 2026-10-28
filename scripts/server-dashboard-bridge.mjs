import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, open, stat, unlink } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { isCliEntry } from "./cli-entry.mjs";

class BridgeError extends Error {
  constructor(code) { super(code); this.code = code; }
}

function id(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value)) throw new BridgeError("MESSAGE_ID_INVALID");
  return value;
}

async function boundedFile(filename) {
  const handle = await open(filename, "r");
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.size > 8_192) throw new BridgeError("INPUT_TOO_LARGE_OR_INVALID");
    const bytes = await handle.readFile();
    if (bytes.byteLength > 8_192) throw new BridgeError("INPUT_TOO_LARGE_OR_INVALID");
    return bytes.toString("utf8").replace(/^\uFEFF/, "");
  } finally { await handle.close(); }
}

async function temporary(directory, extension, content, created) {
  const filename = path.join(directory, `${randomUUID()}.${extension}`);
  const handle = await open(filename, "wx", 0o600);
  created.push(filename);
  try { await handle.writeFile(content); }
  finally { await handle.close(); }
  return filename;
}

async function runtime(root) {
  const directory = path.join(root, "data/operator");
  const data = JSON.parse(await boundedFile(path.join(directory, "runtime.json")));
  const helper = path.join(root, "scripts/server-ssh.py");
  if (typeof data.python !== "string" || !path.isAbsolute(data.python)) throw new BridgeError("PYTHON_RUNTIME_INVALID");
  for (const filename of [data.python, helper, path.join(directory, "known_hosts")]) {
    if (!(await stat(filename)).isFile()) throw new BridgeError("SSH_RUNTIME_UNAVAILABLE");
  }
  return { python: data.python, helper, temporaryDirectory: path.join(directory, "tmp") };
}

function runPython(binary, args, options) {
  return new Promise((resolve, reject) => {
    execFile(binary, args, options, (error, stdout) => {
      if (error) reject(new BridgeError("SSH_OPERATION_FAILED"));
      else resolve(stdout);
    });
  });
}

function publication(text) {
  const payload = JSON.parse(text);
  if (!payload || Array.isArray(payload) || typeof payload !== "object" ||
      Object.keys(payload).some((key) => !["title", "message", "tags"].includes(key)) ||
      typeof payload.message !== "string" || !payload.message.trim() || Buffer.byteLength(payload.message) > 4_096 ||
      (payload.title !== undefined && (typeof payload.title !== "string" || Buffer.byteLength(payload.title) > 256)) ||
      (payload.tags !== undefined && (!Array.isArray(payload.tags) || payload.tags.length > 8 ||
        payload.tags.some((tag) => typeof tag !== "string" || !/^[A-Za-z0-9_+-]{1,64}$/.test(tag))))) {
    throw new BridgeError("PUBLISH_INPUT_INVALID");
  }
  const normalized = JSON.stringify(payload);
  if (Buffer.byteLength(normalized) > 8_192) throw new BridgeError("INPUT_TOO_LARGE_OR_INVALID");
  return normalized;
}

function result(action, text, expectedId) {
  let data;
  try { data = JSON.parse(text); }
  catch { throw new BridgeError("REMOTE_RESPONSE_INVALID"); }
  if (action === "poll" && data?.status === "read" && Array.isArray(data.messages) && data.messages.length <= 1_000) {
    const since = data.since === "all" ? "all" : id(data.since);
    const messages = data.messages.map((row) => {
      if (!row || !Number.isSafeInteger(row.time) || row.time < 0 || typeof row.title !== "string" || typeof row.message !== "string") {
        throw new BridgeError("REMOTE_RESPONSE_INVALID");
      }
      return { id: id(row.id), time: row.time, title: row.title, message: row.message };
    });
    return { status: "read", since, messages };
  }
  if (action === "publish" && data?.status === "published") return { status: "published", id: id(data.id) };
  if (action === "ack" && data?.status === "acknowledged" && data.id === expectedId) return { status: "acknowledged", id: id(data.id) };
  throw new BridgeError("REMOTE_RESPONSE_INVALID");
}

async function perform(args, { root = fileURLToPath(new URL("../", import.meta.url)), execute = runPython } = {}) {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, strict: true,
    options: { "input-file": { type: "string" }, id: { type: "string" }, help: { type: "boolean" } } });
  if (values.help) {
    process.stdout.write("server-dashboard-bridge.mjs poll | ack --id ID | publish --input-file LOCAL_JSON\nUses the existing private SSH helper and credentials; no new SSH keys or server access.\n");
    return;
  }
  const [action] = positionals;
  if (positionals.length !== 1 || !["poll", "ack", "publish"].includes(action) ||
      (action === "publish" && (!values["input-file"] || values.id)) ||
      (action === "ack" && (!values.id || values["input-file"])) ||
      (action === "poll" && (values.id || values["input-file"]))) throw new BridgeError("OPTIONS_INVALID");
  const expectedId = action === "ack" ? id(values.id) : undefined;
  const payload = action === "publish" ? publication(await boundedFile(path.resolve(values["input-file"]))) : undefined;
  const config = await runtime(root);
  const created = [];
  const options = { timeout: 45_000, maxBuffer: 1_048_576, encoding: "utf8", windowsHide: true, signal: AbortSignal.timeout(45_000) };
  // Every remote path is generated here; no user text contributes to its name.
  const remoteFile = payload === undefined ? undefined : `/srv/rimo/private/bridge-progress-${randomUUID()}.json`;
  let remoteMayExist = false;
  let remoteRunFinished = false;
  let output;
  try {
    await mkdir(config.temporaryDirectory, { recursive: true, mode: 0o700 });
    const command = `node /srv/rimo/current/scripts/server-dashboard.mjs ${action === "publish" ? `publish --input-file ${remoteFile}` : action === "ack" ? `ack --id ${expectedId}` : "poll"}`;
    const cleanup = remoteFile ? `rm -f -- ${remoteFile}` : undefined;
    const script = await temporary(config.temporaryDirectory, "sh",
      `set -eu\n${cleanup ? `trap '${cleanup}' EXIT\n` : ""}${command}\n${cleanup ? `${cleanup}\n` : ""}`, created);
    if (payload !== undefined) {
      const filename = await temporary(config.temporaryDirectory, "json", payload, created);
      remoteMayExist = true;
      await execute(config.python, [config.helper, "upload", filename, remoteFile], options);
    }
    const text = await execute(config.python, [config.helper, "run", script], options);
    remoteRunFinished = true;
    output = result(action, text, expectedId);
  } finally {
    let remoteCleanupFailed = false;
    if (remoteMayExist && !remoteRunFinished) {
      try {
        const cleanup = await temporary(config.temporaryDirectory, "sh", `set -eu\nrm -f -- ${remoteFile}\n`, created);
        await execute(config.python, [config.helper, "run", cleanup], options);
      } catch { remoteCleanupFailed = true; }
    }
    const removed = await Promise.allSettled(created.map((filename) => unlink(filename)));
    if (removed.some((entry) => entry.status === "rejected")) throw new BridgeError("LOCAL_CLEANUP_FAILED");
    if (remoteCleanupFailed) throw new BridgeError("REMOTE_PROGRESS_CLEANUP_UNCONFIRMED");
  }
  process.stdout.write(`${JSON.stringify(output)}\n`);
}

/** Injected repository and runner are for offline checks, never CLI options. */
export async function main(args = process.argv.slice(2), dependencies = {}) {
  try { await perform(args, dependencies); }
  catch (error) { throw error instanceof BridgeError ? error : new BridgeError("DASHBOARD_BRIDGE_FAILED"); }
}

if (await isCliEntry(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${JSON.stringify({ status: "failed", code: error instanceof BridgeError ? error.code : "DASHBOARD_BRIDGE_FAILED" })}\n`);
    process.exitCode = 1;
  });
}
