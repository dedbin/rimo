import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { request } from "playwright";
import { createDecoder, readVarString, readVarUint } from "lib0/decoding";
import WebSocket from "ws";

import { parseServerMessage } from "../../lib/collaboration/protocol.ts";
import { CookieScopeError, websocketCookieHeader } from "./cookies.mjs";

const execute = promisify(execFile);
const require = createRequire(import.meta.url);
// Source .ts modules use CommonJS under tsx in this repository. Keep one Yjs instance.
export const Y = require("yjs");
const { HocuspocusProvider, HocuspocusProviderWebsocket } = require("@hocuspocus/provider");

class HarnessError extends Error {}
export const fail = (message) => new HarnessError(message);

export function safeError(error) {
  // Playwright appends request headers, including session cookies, in its call log.
  if (error instanceof HarnessError || error instanceof CookieScopeError) return error.message.split(/\r?\n/)[0].slice(0, 320);
  const message = error instanceof Error ? error.message : "";
  const operation = ["apiRequestContext.fetch", "page.goto", "page.evaluate", "locator.waitFor", "browserType.launch"]
    .find((name) => message.startsWith(`${name}:`));
  const code = ["ECONNREFUSED", "ETIMEDOUT", "ENOTFOUND", "ECONNRESET", "EHOSTUNREACH"]
    .find((name) => message.includes(name));
  if (error?.name === "AbortError") return "Operation interrupted";
  return `${operation ?? "Operation"} failed${code ? ` (${code})` : ""}`;
}

export async function waitFor(predicate, timeout = 15_000, signal) {
  const deadline = performance.now() + timeout;
  while (!predicate()) {
    signal?.throwIfAborted();
    if (performance.now() >= deadline) throw fail("Timed out waiting for benchmark state");
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
}

export function distribution(values) {
  const sorted = values.toSorted((a, b) => a - b);
  const at = (fraction) => sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)] ?? null;
  return { count: sorted.length, p50: at(0.5), p95: at(0.95), max: sorted.at(-1) ?? null };
}

export function positiveInteger(value, name, maximum = 100_000) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > maximum) throw fail(`${name} must be between 1 and ${maximum}`);
  return parsed;
}

export function installLoadInterruptHandlers(controller) {
  const interrupt = () => { process.exitCode = 1; controller.abort(); };
  const signals = ["SIGINT", "SIGTERM", "SIGHUP"];
  for (const signal of signals) process.on(signal, interrupt);
  return () => { for (const signal of signals) process.off(signal, interrupt); };
}

export async function environment(label) {
  const commit = await execute("git", ["rev-parse", "HEAD"], { windowsHide: true, timeout: 5_000 }).then((result) => result.stdout.trim(), () => null);
  const dirty = await execute("git", ["status", "--porcelain"], { windowsHide: true, timeout: 5_000 }).then((result) => !!result.stdout.trim(), () => null);
  const next = JSON.parse(await readFile("node_modules/next/package.json", "utf8")).version;
  const dependencies = Object.fromEntries(await Promise.all(["@hocuspocus/provider", "@hocuspocus/server", "yjs", "playwright", "katex", "sharp", "tough-cookie"]
    .map(async (name) => [name, JSON.parse(await readFile(`node_modules/${name}/package.json`, "utf8")).version])));
  const sources = ["scripts/measure-editor.mjs", "scripts/load-collaboration.mjs", ...["common", "cookies", "fixture", "browser-metrics", "load-runner", "self-test", "self-load"]
    .map((name) => `scripts/performance/${name}.mjs`)];
  const sourceHash = createHash("sha256");
  for (const filename of sources) { sourceHash.update(filename); sourceHash.update(await readFile(filename)); }
  return { label, recordedAt: new Date().toISOString(), commit, dirty, node: process.version, next,
    dependencies, harnessSha256: sourceHash.digest("hex"),
    os: { platform: os.platform(), release: os.release(), architecture: os.arch() },
    cpu: { model: os.cpus()[0]?.model, logicalCores: os.cpus().length },
    ramBytes: os.totalmem(), freeRamBytes: os.freemem() };
}

export async function writeReport(filename, report, quiet = false) {
  const resolved = path.resolve(filename);
  await mkdir(path.dirname(resolved), { recursive: true });
  const staging = `${resolved}.pending-${randomBytes(8).toString("hex")}`;
  try {
    await writeFile(staging, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    await rename(staging, resolved);
  } finally { await rm(staging, { force: true }); }
  if (!quiet) process.stdout.write(`${JSON.stringify({ report: resolved, status: report.status })}\n`);
}

export async function writeFinalReport(filename, report, signal) {
  let interrupted;
  do {
    interrupted = signal.aborted;
    if (interrupted) {
      report.interrupted = true; process.exitCode = 1;
      if (report.status !== "cleanup-failed") report.status = "interrupted";
    }
    await writeReport(filename, report, true);
    // An abort during the asynchronous write must replace its earlier snapshot.
  } while (interrupted !== signal.aborted);
  process.stdout.write(`${JSON.stringify({ report: path.resolve(filename), status: report.status })}\n`);
}

export async function api(context, method, resource, data) {
  const response = await context.fetch(resource, { method, ...(data === undefined ? {} : { data }) });
  if (!response.ok()) throw fail(`${method} ${resource.split("?")[0]} returned HTTP ${response.status()}`);
  return response.status() === 204 ? null : response.json();
}

export async function ownerContext(baseURL, storageState) {
  const target = new URL(baseURL);
  if (!["http:", "https:"].includes(target.protocol) || target.username || target.password || target.pathname !== "/" || target.search || target.hash) {
    throw fail("Use an HTTP(S) application origin without credentials, a path or query parameters");
  }
  const context = await request.newContext({ baseURL, storageState, timeout: 15_000, extraHTTPHeaders: { origin: new URL(baseURL).origin } });
  try {
    const session = await api(context, "GET", "/api/auth/get-session");
    if (!session?.user?.id || session.user.isAnonymous) throw fail("Use a signed-in owner storage state");
    return context;
  } catch (error) { await context.dispose(); throw error; }
}

export async function viewerContext(baseURL, filename) {
  const existing = await readFile(filename, "utf8").then(JSON.parse, (error) => { if (error.code === "ENOENT") return null; throw error; });
  const context = await request.newContext({ baseURL, ...(existing ? { storageState: existing } : {}),
    timeout: 15_000, extraHTTPHeaders: { origin: new URL(baseURL).origin } });
  try {
    let session = await api(context, "GET", "/api/auth/get-session");
    let created = false;
    if (!session?.user?.id) {
      await api(context, "POST", "/api/auth/sign-in/anonymous", {});
      session = await api(context, "GET", "/api/auth/get-session");
      created = true;
    }
    if (!session?.user?.isAnonymous) throw fail("The viewer fixture must use an anonymous test account");
    await mkdir(path.dirname(path.resolve(filename)), { recursive: true });
    await writeFile(filename, `${JSON.stringify(await context.storageState())}\n`, { mode: 0o600 });
    return { context, created, retained: true };
  } catch (error) { await context.dispose(); throw error; }
}

export async function createBoard(context, title) {
  return (await api(context, "POST", "/api/boards", { title })).board.id;
}

export async function removeBoards(context, ids) {
  const failures = [];
  for (const id of ids) {
    try { await api(context, "DELETE", `/api/boards/${id}`); }
    catch (error) { failures.push({ boardId: id, message: safeError(error) }); }
  }
  return failures;
}

function wireStatistics() {
  return { sentBytes: 0, receivedBytes: 0, sentMessages: 0, receivedMessages: 0, sentTypes: {}, receivedTypes: {} };
}

function trackFrame(stats, direction, data) {
  const bytes = typeof data === "string" ? Buffer.from(data) : Buffer.from(data);
  stats[`${direction}Bytes`] += bytes.byteLength;
  stats[`${direction}Messages`] += 1;
  let type = "unknown";
  try {
    const decoder = createDecoder(bytes);
    readVarString(decoder);
    type = String(readVarUint(decoder));
    if (type === "0") type += `:${readVarUint(decoder)}`;
  } catch { /* Count unsupported frames as bytes without inspecting their payload. */ }
  const types = stats[`${direction}Types`];
  types[type] = (types[type] ?? 0) + 1;
}

export async function openProvider(context, baseURL, boardId, signal) {
  const session = await api(context, "GET", `/api/boards/${boardId}/session`);
  const origin = new URL(baseURL).origin;
  const cookie = await websocketCookieHeader(context, baseURL, session.connection.url);
  let stats = wireStatistics();
  let acknowledgement;
  let closed = false;
  let failure = null;
  const document = new Y.Doc();
  const websocket = new HocuspocusProviderWebsocket({ url: session.connection.url, autoConnect: false,
    maxAttempts: 1, jitter: false, initialDelay: 0,
    WebSocketPolyfill: class extends WebSocket {
      constructor(url) {
        super(url, { headers: { origin, cookie } });
        this.on("message", (data) => trackFrame(stats, "received", data));
      }
      send(data, ...args) { trackFrame(stats, "sent", data); return super.send(data, ...args); }
    },
  });
  const provider = new HocuspocusProvider({ name: boardId, document, token: session.connection.token, websocketProvider: websocket,
    onAuthenticationFailed: () => { if (!closed) failure = "Authentication failed"; },
    onClose: ({ event }) => { if (!closed) failure = `Connection closed (${event.code})`; },
    onStateless: ({ payload }) => {
      const message = parseServerMessage(payload);
      if (message?.type === "persisted") acknowledgement = { ...message, receivedAt: performance.now() };
      if (message?.type === "persistence-error") failure = "Persistence failed without a database acknowledgement";
    },
  });
  provider.attach();
  const result = {
    boardId, document, provider, websocket, session,
    get failure() { return failure; },
    get stats() { return structuredClone(stats); },
    get acknowledgement() { return acknowledgement; },
    get bufferedAmount() { return websocket.webSocket?.bufferedAmount ?? 0; },
    resetStatistics() { stats = wireStatistics(); },
    isPersisted() { return !!acknowledgement && Y.equalSnapshots(Y.snapshot(document),
      Y.decodeSnapshot(Buffer.from(acknowledgement.snapshot, "base64"))); },
    async close() {
      closed = true;
      const socket = websocket.webSocket;
      const ended = socket && socket.readyState !== WebSocket.CLOSED
        ? new Promise((resolve) => { socket.once("close", resolve); const timer = setTimeout(resolve, 1_000); timer.unref(); }) : Promise.resolve();
      provider.destroy(); websocket.destroy(); document.destroy();
      await ended;
    },
  };
  try {
    void websocket.connect().catch(() => { failure = "WebSocket connection failed"; });
    await waitFor(() => { if (failure) throw fail(failure); return provider.isSynced; }, 15_000, signal);
    provider.sendStateless(JSON.stringify({ type: "persistence-status" }));
    await waitFor(() => { if (failure) throw fail(failure); return result.isPersisted(); }, 15_000, signal);
    return result;
  } catch (error) { await result.close(); throw error; }
}

async function dockerIds(project) {
  if (!/^[a-z0-9][a-z0-9_-]{0,62}$/.test(project)) throw fail("Invalid Compose project name");
  const result = await execute("docker", ["ps", "--filter", `label=com.docker.compose.project=${project}`, "--format", "{{.ID}}"],
    { windowsHide: true, timeout: 10_000 });
  const ids = result.stdout.trim().split(/\r?\n/).filter(Boolean);
  if (!ids.length) throw fail("No running containers found for the measured Compose project");
  return ids;
}

export async function dockerSample(project) {
  if (!project) return null;
  const ids = await dockerIds(project);
  const stats = await execute("docker", ["stats", "--no-stream", "--format", "{{json .}}", ...ids], { windowsHide: true, timeout: 10_000 });
  return stats.stdout.trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
}

export async function dockerEnvironment(project) {
  if (!project) return null;
  const ids = await dockerIds(project);
  // Never request full inspect output: Config.Env contains service secrets.
  const format = '{"name":{{json .Name}},"image":{{json .Config.Image}},"imageId":{{json .Image}},"memoryLimitBytes":{{.HostConfig.Memory}},"nanoCpus":{{.HostConfig.NanoCpus}},"cpuQuota":{{.HostConfig.CpuQuota}},"cpuPeriod":{{.HostConfig.CpuPeriod}}}';
  const result = await execute("docker", ["inspect", "--format", format, ...ids], { windowsHide: true, timeout: 10_000 });
  const host = await execute("docker", ["info", "--format", '{"cpuCount":{{.NCPU}},"memoryBytes":{{.MemTotal}},"os":{{json .OperatingSystem}},"kernel":{{json .KernelVersion}},"storageDriver":{{json .Driver}}}'],
    { windowsHide: true, timeout: 10_000 });
  return { host: JSON.parse(host.stdout), containers: result.stdout.trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line)) };
}

export async function roundTrip(peer) {
  const socket = peer.websocket.webSocket;
  if (!socket || socket.readyState !== WebSocket.OPEN) return null;
  const payload = randomBytes(8);
  const start = performance.now();
  return new Promise((resolve) => {
    const finish = (value) => { clearTimeout(timer); socket.off("pong", pong); resolve(value); };
    const pong = (data) => { if (Buffer.from(data).equals(payload)) finish(performance.now() - start); };
    const timer = setTimeout(() => finish(null), 2_000);
    socket.on("pong", pong);
    socket.ping(payload);
  });
}
