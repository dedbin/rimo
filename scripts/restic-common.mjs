import { spawn } from "node:child_process";
import { lstat, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";

import { readBackupManifest } from "./backup-common.mjs";

export const MAX_AGE_MS = 24 * 60 * 60 * 1_000;
export const CLOCK_SKEW_MS = 60_000;
export const COMMAND_TIMEOUT_MS = 30 * 60 * 1_000;
export const METADATA_TIMEOUT_MS = 60_000;
export const SNAPSHOT_ID = /^[a-f0-9]{64}$/;
const SOURCE_TAG_PREFIX = "rimo-source:";

export class ResticFailure extends Error {
  constructor(code) { super(code); this.code = code; }
}

export function sourceTag(timestamp) { return `${SOURCE_TAG_PREFIX}${new Date(timestamp).toISOString()}`; }

/** Source capture time survives a later re-upload of the same local dump. */
export function snapshotSourceTime(snapshot, projectTag) {
  const tags = snapshot.tags.filter(tag => tag.startsWith(SOURCE_TAG_PREFIX));
  const text = tags[0]?.slice(SOURCE_TAG_PREFIX.length);
  const timestamp = Date.parse(text);
  if (snapshot.tags.length !== 2 || !snapshot.tags.includes(projectTag) || tags.length !== 1 ||
      !Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== text ||
      timestamp > Date.parse(snapshot.time) + CLOCK_SKEW_MS) throw new ResticFailure("INVALID_SOURCE_TIME");
  return timestamp;
}

export function sourceFreshness(timestamp, now) {
  const ageSeconds = Math.floor((now - timestamp) / 1_000);
  const status = now - timestamp < -CLOCK_SKEW_MS ? "future" : now - timestamp > MAX_AGE_MS ? "stale" : "fresh";
  return { status, ageSeconds };
}

export function resticOptions(args) {
  try {
    const { values } = parseArgs({ args, strict: true, allowPositionals: false, options: {
      input: { type: "string" }, project: { type: "string" }, "check-age": { type: "boolean" },
    } });
    if (!/^[a-z0-9][a-z0-9_-]{0,62}$/.test(values.project ?? "") ||
        (values["check-age"] ? values.input !== undefined : !values.input)) throw new Error();
    return { project: values.project, input: values.input, checkAge: values["check-age"] === true };
  } catch { throw new ResticFailure("INVALID_OPTIONS"); }
}

export async function resticEnvironment(environment) {
  const configured = [environment.RESTIC_REPOSITORY, environment.RESTIC_REPOSITORY_FILE]
    .filter(value => typeof value === "string" && value.trim());
  if (configured.length !== 1 || !environment.RESTIC_PASSWORD_FILE ||
      environment.RESTIC_PASSWORD !== undefined || environment.RESTIC_PASSWORD_COMMAND !== undefined) {
    throw new ResticFailure("INVALID_CREDENTIAL_CONFIGURATION");
  }
  for (const filename of [environment.RESTIC_PASSWORD_FILE, environment.RESTIC_REPOSITORY_FILE].filter(Boolean)) {
    if (!(await lstat(filename)).isFile()) throw new ResticFailure("INVALID_CREDENTIAL_FILE");
  }
  const result = { ...environment };
  delete result.RESTIC_HOST;
  return result;
}

export async function verifyLocalBackup(input, project, signal) {
  signal?.throwIfAborted();
  const directory = path.resolve(input);
  if (!(await lstat(directory)).isDirectory() || path.basename(directory).startsWith(".rimo-backup-stage-")) {
    throw new ResticFailure("INCOMPLETE_LOCAL_BACKUP");
  }
  const expected = ["assets.tar", "database.dump", "manifest.json"];
  if (JSON.stringify((await readdir(directory)).sort()) !== JSON.stringify(expected)) {
    throw new ResticFailure("UNEXPECTED_LOCAL_FILES");
  }
  for (const name of expected) {
    const file = await lstat(path.join(directory, name));
    if (!file.isFile() || (name === "manifest.json" && file.size > 65_536)) throw new ResticFailure("INVALID_LOCAL_FILE");
  }
  const manifest = await readBackupManifest(directory);
  if (manifest.sourceProject !== project) throw new ResticFailure("LOCAL_PROJECT_MISMATCH");
  signal?.throwIfAborted();
  return { directory: await realpath(directory), manifest };
}

export function readSummary(output, { allowErrors = false } = {}) {
  try {
    const messages = output.trim().split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
    const summaries = messages.filter(message => message?.message_type === "summary");
    if (summaries.length !== 1 || messages.at(-1) !== summaries[0] ||
        messages.some(message => !message || typeof message !== "object" || Array.isArray(message) ||
          typeof message.message_type !== "string" || (!allowErrors && (message.message_type === "error" || message.error_count > 0)))) throw new Error();
    return summaries[0];
  } catch { throw new ResticFailure("INVALID_RESTIC_SUMMARY"); }
}

export function readSnapshots(output) {
  try {
    const snapshots = JSON.parse(output);
    if (!Array.isArray(snapshots) || snapshots.length > 10_000) throw new Error();
    for (const item of snapshots) {
      if (!item || typeof item.id !== "string" || !SNAPSHOT_ID.test(item.id) || typeof item.hostname !== "string" ||
          typeof item.time !== "string" || !/^\d{4}-\d\d-\d\dT/.test(item.time) || !Number.isFinite(Date.parse(item.time)) ||
          !Array.isArray(item.paths) || !item.paths.length || !item.paths.every(value => typeof value === "string") ||
          !Array.isArray(item.tags) || !item.tags.every(value => typeof value === "string")) throw new Error();
    }
    return snapshots;
  } catch { throw new ResticFailure("INVALID_SNAPSHOT_METADATA"); }
}

/** @returns {Promise<{ stdout: string, exitCode: number | null, signal: string | null }>} */
export function runRestic(args, environment, signal, timeoutMs = COMMAND_TIMEOUT_MS,
  { spawnProcess = spawn, maxOutputBytes = 8 * 1024 * 1024, killGraceMs = 2_000 } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new ResticFailure("CANCELLED")); return; }
    let child;
    try {
      child = spawnProcess("restic", args, { env: environment, stdio: ["ignore", "pipe", "pipe"], windowsHide: true, shell: false });
    } catch { reject(new ResticFailure("RESTIC_SPAWN_FAILED")); return; }
    const chunks = [];
    let bytes = 0;
    let settled = false;
    let failure;
    let escalation;
    let finalDeadline;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline); clearTimeout(escalation); clearTimeout(finalDeadline);
      signal?.removeEventListener("abort", abort);
      if (error) reject(error); else resolve(result);
    };
    const terminate = (code) => {
      if (failure || settled) return;
      failure = new ResticFailure(code);
      escalation = setTimeout(() => {
        try { child.kill("SIGKILL"); } catch { /* The final deadline still rejects. */ }
      }, killGraceMs);
      finalDeadline = setTimeout(() => {
        child.stdout?.destroy(); child.stderr?.destroy(); child.unref(); finish(failure);
      }, killGraceMs * 2);
      try { child.kill("SIGTERM"); } catch { /* Escalation remains bounded. */ }
    };
    const abort = () => terminate("CANCELLED");
    const deadline = setTimeout(() => terminate("RESTIC_TIMEOUT"), timeoutMs);
    const consume = (chunk, stdout) => {
      bytes += chunk.byteLength;
      if (bytes > maxOutputBytes) terminate("RESTIC_OUTPUT_LIMIT");
      else if (stdout && !failure) chunks.push(chunk);
    };
    child.stdout.on("data", chunk => consume(chunk, true));
    child.stderr.on("data", chunk => consume(chunk, false));
    child.stdout.on("error", () => terminate("RESTIC_STREAM_FAILED"));
    child.stderr.on("error", () => terminate("RESTIC_STREAM_FAILED"));
    child.once("error", () => finish(failure ?? new ResticFailure("RESTIC_SPAWN_FAILED")));
    child.once("close", (exitCode, exitSignal) => finish(failure, {
      stdout: Buffer.concat(chunks).toString("utf8"), exitCode, signal: exitSignal,
    }));
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
  });
}
