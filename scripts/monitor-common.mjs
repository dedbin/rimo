import { spawn } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { parseArgs, parseEnv } from "node:util";

import { storageSpaceHealth } from "../lib/storage-space.mjs";

export const SERVICES = Object.freeze(["app", "collaboration", "db", "export-worker", "caddy"]);
export const LIMITS = Object.freeze({ deadlineMs: 45_000, commandMs: 10_000, outputBytes: 65_536,
  logBytes: 262_144, logLines: 500, logWindowSeconds: 300 });
const STATUSES = Object.freeze(["healthy", "warning", "critical"]);
export class MonitorError extends Error {
  constructor(code) { super(code); this.code = code; }
}
const check = (value, code) => { if (!value) throw new MonitorError(code); };
export const exitCode = (status) => STATUSES.includes(status) ? STATUSES.indexOf(status) : 2;
export function result(status, reasonCodes = [], data = null) { return { status, reasonCodes, data }; }
export const critical = (code) => result("critical", [code]);
export function aggregate(checks) {
  return { status: STATUSES[Math.max(0, ...Object.values(checks).map((entry) => exitCode(entry.status)))],
    reasonCodes: [...new Set(Object.values(checks).flatMap((entry) => entry.reasonCodes))] };
}

export function monitorOptions(args, cwd = process.cwd()) {
  const { values } = parseArgs({ args, options: { help: { type: "boolean" }, project: { type: "string" },
    "env-file": { type: "string" }, "compose-file": { type: "string" } } });
  if (values.help) return { help: true };
  check(typeof values.project === "string" && /^[a-z0-9][a-z0-9_-]{0,62}$/.test(values.project), "CONFIGURATION_INVALID");
  check(values["env-file"] && values["compose-file"], "CONFIGURATION_INVALID");
  return { project: values.project, envFile: path.resolve(cwd, values["env-file"]), composeFile: path.resolve(cwd, values["compose-file"]) };
}

/**
 * @param {Record<string, string | undefined>} [inherited]
 * @returns {Promise<Record<string, string | undefined>>}
 */
export async function monitorEnvironment(options, signal, inherited = process.env) {
  const files = await Promise.all([stat(options.envFile), stat(options.composeFile)]);
  check(files[0].isFile() && files[0].size <= LIMITS.outputBytes && files[1].isFile() && files[1].size <= LIMITS.logBytes, "CONFIGURATION_INVALID");
  const environment = { ...inherited, NO_COLOR: "1", COMPOSE_ANSI: "never" };
  // Compose reads the selected private file; inherited values must not override it.
  const privateFile = await readFile(options.envFile, { encoding: "utf8", signal });
  check(Buffer.byteLength(privateFile) <= LIMITS.outputBytes, "CONFIGURATION_INVALID");
  for (const key of Object.keys(parseEnv(privateFile))) delete environment[key];
  return environment;
}

/**
 * No shell, inherited terminal, or raw error forwarding, including on failure.
 * @param {{environment: Record<string, string | undefined>, signal?: AbortSignal, program?: string, timeoutMs?: number, spawnProcess?: typeof spawn}} options
 * @returns {(args: string[], options?: {logs?: boolean}) => Promise<{code: number|null, problem?: string, stdout: string, stderr: string}>}
 */
export function createDockerRunner({ environment, signal, program = "docker", timeoutMs = LIMITS.commandMs, spawnProcess = spawn }) {
  return (args, { logs = false } = {}) => new Promise((resolve) => {
    if (signal?.aborted) { resolve({ code: null, problem: "INTERRUPTED", stdout: "", stderr: "" }); return; }
    let child; let done = false; let problem; let bytes = 0; let timer; let force;
    const stdout = []; const stderr = [];
    const finish = (code = null) => {
      if (done) return; done = true; clearTimeout(timer); clearTimeout(force); signal?.removeEventListener("abort", abort);
      resolve({ code, problem, stdout: problem ? "" : Buffer.concat(stdout).toString("utf8"),
        stderr: problem || !logs ? "" : Buffer.concat(stderr).toString("utf8") });
    };
    const stop = (code) => {
      problem ??= code;
      child?.kill("SIGKILL");
      force ??= setTimeout(() => { child?.stdout?.destroy(); child?.stderr?.destroy(); child?.unref(); finish(); }, 1_000);
    };
    const abort = () => stop("INTERRUPTED");
    const capture = (chunks, retain) => (input) => {
      bytes += input.byteLength;
      if (bytes > (logs ? LIMITS.logBytes : LIMITS.outputBytes)) stop("OUTPUT_LIMIT");
      else if (retain && !problem) chunks.push(Buffer.from(input));
    };
    try {
      child = spawnProcess(program, args, { env: environment, windowsHide: true, shell: false, stdio: ["ignore", "pipe", "pipe"] });
      child.stdout.on("data", capture(stdout, true)); child.stderr.on("data", capture(stderr, logs));
      child.stdout.on("error", () => stop("STREAM_FAILED")); child.stderr.on("error", () => stop("STREAM_FAILED"));
      child.once("error", () => { problem ??= "SPAWN_FAILED"; finish(); });
      child.once("close", finish);
      timer = setTimeout(() => stop("TIMEOUT"), timeoutMs);
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
    } catch { problem = "SPAWN_FAILED"; finish(); }
  });
}

export const INSPECT_FORMAT = '{"id":{{json .Id}},"project":{{json (index .Config.Labels "com.docker.compose.project")}},"service":{{json (index .Config.Labels "com.docker.compose.service")}},"state":{{json .State.Status}},"health":{{with index .State "Health"}}{{json .Status}}{{else}}null{{end}},"restarts":{{.RestartCount}},"oomKilled":{{.State.OOMKilled}}}';
export const APP_STATUS_SCRIPT = 'const deadline=setTimeout(()=>process.exit(124),8000);deadline.unref();await import("./scripts/service-status.ts");';
export const PG_FILESYSTEM_SCRIPT = String.raw`set -eu
test -n "$PGDATA"
for target in "$PGDATA" "$PGDATA/pg_wal"; do
  LC_ALL=C df -B1 --output=avail,size -- "$target" | awk 'NR==2 && $1 ~ /^[0-9]+$/ && $2 ~ /^[0-9]+$/ {print $1 " " $2; found=1} END {if (!found) exit 1}'
done`;
export const PDF_HEALTH_SCRIPT = String.raw`const deadline=setTimeout(()=>process.exit(124),7000);deadline.unref();
try {
  const port=Number(process.env.PDF_WORKER_PORT ?? 3100);
  if(!Number.isInteger(port)||port<1||port>65535) throw new Error();
  const response=await fetch("http://127.0.0.1:"+port+"/healthz",{signal:AbortSignal.timeout(5000),redirect:"error"});
  if(response.status!==200||!response.headers.get("content-type")?.includes("application/json")||Number(response.headers.get("content-length")??0)>4096) throw new Error();
  const chunks=[];let size=0;
  for await(const chunk of response.body){size+=chunk.byteLength;if(size>4096)throw new Error();chunks.push(chunk);}
  const body=JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if(body.ok!==true||typeof body.running!=="boolean"||!Number.isSafeInteger(body.waiting)||body.waiting<0||body.waiting>1000)throw new Error();
  process.stdout.write(JSON.stringify({ok:true,running:body.running,waiting:body.waiting}));
}catch{process.exitCode=2;}`;

export function successful(response, code) {
  check(!response.problem && response.code === 0, code);
  return response.stdout;
}
export function parseIds(text) {
  const ids = text.trim().split(/\s+/).filter(Boolean);
  check(ids.length > 0 && ids.length <= 10 && new Set(ids).size === ids.length && ids.every((id) => /^[a-f0-9]{64}$/.test(id)), "CONTAINER_INVENTORY_INVALID");
  return ids;
}
export function parseContainers(text, project, ids) {
  const rows = text.trim().split(/\r?\n/).map((line) => JSON.parse(line));
  check(rows.length === ids.length, "CONTAINER_INVENTORY_INVALID");
  const allowedStates = new Set(["created", "running", "paused", "restarting", "removing", "exited", "dead"]);
  check(rows.every((entry) => ids.includes(entry.id) && /^[a-f0-9]{64}$/.test(entry.id) && entry.project === project && SERVICES.includes(entry.service) &&
    allowedStates.has(entry.state) && [null, "starting", "healthy", "unhealthy"].includes(entry.health) &&
    Number.isSafeInteger(entry.restarts) && entry.restarts >= 0 && typeof entry.oomKilled === "boolean") && new Set(rows.map((row) => row.id)).size === rows.length,
  "CONTAINER_INVENTORY_INVALID");
  const services = SERVICES.map((service) => {
    const matches = rows.filter((row) => row.service === service);
    if (matches.length !== 1) return { service, ...critical(matches.length ? "CONTAINER_AMBIGUOUS" : "CONTAINER_MISSING") };
    const row = matches[0]; const codes = [];
    if (row.state !== "running") codes.push("CONTAINER_NOT_RUNNING");
    if (row.health === "unhealthy") codes.push("CONTAINER_UNHEALTHY");
    if (["app", "collaboration", "db"].includes(service) && row.health === null) codes.push("CONTAINER_HEALTHCHECK_MISSING");
    if (row.oomKilled) codes.push("CONTAINER_OOM_KILLED");
    const severity = codes.length ? "critical" : row.health === "starting" || row.restarts ? "warning" : "healthy";
    if (row.health === "starting") codes.push("CONTAINER_STARTING");
    if (row.restarts) codes.push("CONTAINER_RESTARTED");
    return { service, status: severity, reasonCodes: codes, data: { id: row.id, state: row.state, health: row.health, restarts: row.restarts, oomKilled: row.oomKilled } };
  });
  return { ...aggregate(Object.fromEntries(services.map((entry) => [entry.service, entry]))), data: services };
}

const USAGE_FIELDS = ["owners", "boards", "documents", "documentBytes", "assets", "assetBytes", "maxBoardsPerOwner", "maxOwnerAssetBytes", "maxBoardAssetBytes"];
const QUOTA_FIELDS = ["maxOwners", "maxBoardsPerOwner", "maxBoardAssetBytes", "maxOwnerAssetBytes", "maxGlobalAssetBytes", "maxGlobalDocumentBytes"];
const STORAGE_FIELDS = ["freeBytes", "totalBytes", "regularFileCount", "fileBytes", "skippedDirectories", "skippedLinks"];
const APP_CODES = new Set(["CONFIGURATION_OR_STATUS_FAILED", "DATABASE_CHECK_FAILED", "STORAGE_CHECK_FAILED", "STORAGE_ACCESS_FAILED",
  "STORAGE_ROOT_INVALID", "STORAGE_ROOT_UNSAFE", "STORAGE_ROOT_CHANGED", "METRICS_OUT_OF_RANGE", "STORAGE_SPACE_CRITICAL", "STORAGE_SPACE_LOW",
  ...["OWNERS", "BOARDS_PER_OWNER", "BOARD_ASSETS", "OWNER_ASSETS", "GLOBAL_ASSETS", "GLOBAL_DOCUMENTS"].flatMap((name) => [`${name}_LIMIT_NEAR`, `${name}_LIMIT_REACHED`])]);
function numbers(value, fields, code) {
  check(value && fields.every((key) => Number.isSafeInteger(value[key]) && value[key] >= 0), code);
  return Object.fromEntries(fields.map((key) => [key, value[key]]));
}
export function parseAppStatus(response) {
  check(!response.problem && [0, 1, 2].includes(response.code), "APP_STATUS_UNAVAILABLE");
  const body = JSON.parse(response.stdout);
  check(body.version === 1 && STATUSES.includes(body.status) && exitCode(body.status) === response.code, "APP_STATUS_EXIT_MISMATCH");
  check(Array.isArray(body.reasonCodes) && body.reasonCodes.length <= 32 && body.reasonCodes.every((code) => APP_CODES.has(code)) &&
    (body.status === "healthy" ? body.reasonCodes.length === 0 : body.reasonCodes.length > 0), "APP_STATUS_INVALID");
  check(typeof body.checkedAt === "string" && Number.isFinite(Date.parse(body.checkedAt)), "APP_STATUS_INVALID");
  const data = { checkedAt: new Date(body.checkedAt).toISOString(), usage: null, quotas: null, storage: null, databaseReachable: null };
  if (!body.reasonCodes.includes("CONFIGURATION_OR_STATUS_FAILED")) {
    check(typeof body.database?.reachable === "boolean", "APP_STATUS_INVALID"); data.databaseReachable = body.database.reachable;
    data.usage = body.usage === null ? null : numbers(body.usage, USAGE_FIELDS, "APP_STATUS_INVALID");
    data.quotas = numbers(body.quotas, QUOTA_FIELDS, "APP_STATUS_INVALID");
    check(Object.values(data.quotas).every((value) => value > 0), "APP_STATUS_INVALID");
    if (body.storage !== null) {
      check(typeof body.storage?.readable === "boolean" && typeof body.storage?.writable === "boolean", "APP_STATUS_INVALID");
      data.storage = { ...numbers(body.storage, STORAGE_FIELDS, "APP_STATUS_INVALID"), readable: body.storage.readable, writable: body.storage.writable };
    }
    check(body.status === "critical" || (data.databaseReachable && data.usage && data.storage?.readable && data.storage.writable), "APP_STATUS_INVALID");
  } else check(body.status === "critical", "APP_STATUS_INVALID");
  return result(body.status, [...body.reasonCodes], data);
}

export function parseFilesystems(text) {
  const lines = text.trim().split(/\r?\n/);
  check(lines.length === 2 && lines.every((line) => /^\d+ \d+$/.test(line)), "POSTGRES_FILESYSTEM_INVALID");
  const data = lines.map((line, index) => {
    const [freeBytes, totalBytes] = line.split(" ").map(Number);
    check(Number.isSafeInteger(freeBytes) && Number.isSafeInteger(totalBytes) && totalBytes > 0 && freeBytes >= 0 && freeBytes <= totalBytes, "POSTGRES_FILESYSTEM_INVALID");
    return { role: index ? "pg_wal" : "pgdata", freeBytes, totalBytes };
  });
  const codes = []; let status = "healthy";
  for (const entry of data) {
    const health = storageSpaceHealth(entry.freeBytes, entry.totalBytes);
    const level = health === "critical" ? "critical" : health === "low" ? "warning" : "healthy";
    if (level !== "healthy") codes.push(`${entry.role === "pgdata" ? "PGDATA" : "PG_WAL"}_SPACE_${level === "critical" ? "CRITICAL" : "LOW"}`);
    if (exitCode(level) > exitCode(status)) status = level;
  }
  return result(status, codes, data);
}
export function parsePdfHealth(text) {
  const body = JSON.parse(text);
  check(body.ok === true && typeof body.running === "boolean" && Number.isSafeInteger(body.waiting) && body.waiting >= 0 && body.waiting <= 1_000, "PDF_HEALTH_INVALID");
  return result(body.waiting ? "warning" : "healthy", body.waiting ? ["PDF_QUEUE_WAITING"] : [], { running: body.running, waiting: body.waiting });
}

export function parseCollaborationLogs(stdout, stderr) {
  const lines = [stdout, stderr].flatMap((text) => text.split(/\r?\n/).filter((line) => line.trim()));
  check(Buffer.byteLength(stdout) + Buffer.byteLength(stderr) <= LIMITS.logBytes, "COLLABORATION_LOGS_LIMIT");
  const data = { windowSeconds: LIMITS.logWindowSeconds, examinedLines: lines.length, tailLimitReached: lines.length >= LIMITS.logLines,
    persistenceFailureRecords: 0, acl: { timeout: 0, dependencyError: 0, denied: 0, editorLimit: 0 }, invalidKnownEvents: 0 };
  const kinds = new Map([["timeout", "timeout"], ["dependency-error", "dependencyError"], ["denied", "denied"], ["editor-limit", "editorLimit"]]);
  for (const line of lines) {
    // Pinned Hocuspocus emits this literal for failed persistence hooks. Stack lines are ignored.
    if (/^\[(?:onStoreDocument|onLoadDocument)\] Board persistence failed$/.test(line.trim())) { data.persistenceFailureRecords += 1; continue; }
    let event; try { event = JSON.parse(line); } catch { continue; }
    if (event?.event !== "collaboration_access_check_failed") continue;
    const name = kinds.get(event.kind);
    if (!name || !Number.isFinite(event.elapsedMs) || event.elapsedMs < 0) data.invalidKnownEvents += 1;
    else data.acl[name] += 1;
  }
  const codes = [];
  if (data.tailLimitReached) codes.push("COLLABORATION_LOG_WINDOW_TRUNCATED");
  if (data.invalidKnownEvents) codes.push("COLLABORATION_LOG_EVENT_INVALID");
  if (data.persistenceFailureRecords) codes.push("COLLABORATION_PERSISTENCE_FAILURE");
  if (data.acl.timeout || data.acl.dependencyError) codes.push("COLLABORATION_ACL_CHECK_FAILURE");
  return result(codes.length ? "critical" : "healthy", codes, data);
}
