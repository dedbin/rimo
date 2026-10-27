import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { lstat, mkdir, readdir, realpath, writeFile } from "node:fs/promises";
import path from "node:path";

import type { composeContext } from "../scripts/backup-common.mjs";
import { readBackupManifest } from "../scripts/backup-common.mjs";
import { performRestic } from "../scripts/restic-backup.mjs";
import { runRestic, SNAPSHOT_ID } from "../scripts/restic-common.mjs";

export interface CommandOptions { signal?: AbortSignal; timeoutMs?: number }
export interface CommandResult { code: number; stdout: string; stderr: string }
export type FixtureCommand = typeof fixtureCommand;
export type FixtureContext = Pick<Awaited<ReturnType<typeof composeContext>>, "args" | "environment" | "config"> & {
  run: (args: string[], signal?: AbortSignal) => Promise<string>;
};

/** Capture private child output in memory; forward neither stderr nor raw errors. */
export async function fixtureCommand(
  program: string, args: string[], environment: NodeJS.ProcessEnv, input?: string, options: CommandOptions = {},
): Promise<CommandResult> {
  const { signal, timeoutMs = 150_000 } = options;
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(program, args, { env: environment, stdio: ["pipe", "pipe", "pipe"], windowsHide: true, shell: false });
    const chunks: Buffer[] = [];
    let bytes = 0; let done = false; let failure: string | undefined;
    let escalation: NodeJS.Timeout | undefined; let finalDeadline: NodeJS.Timeout | undefined;
    const finish = (code: number | null): void => {
      if (done) return;
      done = true; clearTimeout(deadline); clearTimeout(escalation); clearTimeout(finalDeadline);
      signal?.removeEventListener("abort", abort);
      if (failure) reject(new Error(failure));
      else resolve({ code: code ?? 1, stdout: Buffer.concat(chunks).toString("utf8"), stderr: "" });
    };
    const stop = (code: string): void => {
      if (failure || done) return;
      failure = code;
      try { child.kill("SIGTERM"); } catch { /* The final deadline remains active. */ }
      escalation = setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* The final deadline remains active. */ } }, 8_000);
      finalDeadline = setTimeout(() => { child.stdout.destroy(); child.stderr.destroy(); child.unref(); finish(null); }, 10_000);
    };
    const abort = (): void => stop("FIXTURE_INTERRUPTED");
    const deadline = setTimeout(() => stop("FIXTURE_COMMAND_TIMEOUT"), timeoutMs);
    const capture = (chunk: Buffer, retain: boolean): void => {
      bytes += chunk.byteLength;
      if (bytes > 2 * 1024 * 1024) stop("FIXTURE_OUTPUT_LIMIT");
      else if (retain && !failure) chunks.push(Buffer.from(chunk));
    };
    child.stdout.on("data", chunk => capture(chunk, true));
    child.stderr.on("data", chunk => capture(chunk, false));
    child.stdout.on("error", () => stop("FIXTURE_STREAM_FAILED"));
    child.stderr.on("error", () => stop("FIXTURE_STREAM_FAILED"));
    child.stdin.on("error", () => stop("FIXTURE_INPUT_FAILED"));
    child.once("error", () => { failure ??= "FIXTURE_SPAWN_FAILED"; finish(null); });
    child.once("close", finish);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    child.stdin.end(input);
  });
}

/** Reuse production Compose configuration parsing inside a captured private child. */
export async function fixtureContext(values: Parameters<typeof composeContext>[0], signal: AbortSignal): Promise<FixtureContext> {
  const script = `import {composeContext} from './scripts/backup-common.mjs';
const chunks=[];for await(const chunk of process.stdin)chunks.push(chunk);
const {args,environment,config}=await composeContext(JSON.parse(Buffer.concat(chunks).toString('utf8')));
process.stdout.write(JSON.stringify({args,environment,config}));`;
  const response = await fixtureCommand(process.execPath, ["--input-type=module", "-e", script], process.env,
    JSON.stringify(values), { signal, timeoutMs: 30_000 });
  if (response.code !== 0) throw new Error("FIXTURE_COMPOSE_CONFIGURATION_FAILED");
  const context = JSON.parse(response.stdout) as Omit<FixtureContext, "run">;
  return { ...context, run: async (args, runSignal = signal) => {
    const result = await fixtureCommand("docker", [...context.args, ...args], context.environment, undefined, { signal: runSignal });
    if (result.code !== 0) throw new Error("FIXTURE_COMPOSE_COMMAND_FAILED");
    return result.stdout;
  } };
}

/** Register cleanup before create: a lost CLI response does not prove no container exists. */
export function fixtureLock(context: FixtureContext, project: string, owner: string): {
  create: (signal: AbortSignal) => Promise<void>; cleanup: () => Promise<void>;
} {
  if (!/^rimo-backup-src-[a-f0-9]{8}$/.test(project) || !/^[a-f0-9-]{36}$/.test(owner)) throw new Error("FIXTURE_LOCK_PROJECT_INVALID");
  const name = `rimo-backup-lock-${project}`;
  const ownerLabel = "rimo.test.lock-owner";
  let state: "not-requested" | "unknown" | "confirmed" | "removed" = "not-requested";
  let knownId: string | undefined;
  const command = async (args: string[]): Promise<CommandResult> =>
    fixtureCommand("docker", args, context.environment, undefined, { timeoutMs: 20_000 });
  return {
    async create(signal) {
      state = "unknown";
      const reserved = await fixtureCommand("docker", ["create", "--name", name, "--label", `rimo.backup.project=${project}`,
        "--label", `${ownerLabel}=${owner}`, "--entrypoint", "node", context.config.services.app.image, "-e", "process.exit(0)"],
      context.environment, undefined, { signal, timeoutMs: 30_000 });
      const id = reserved.stdout.trim();
      if (reserved.code !== 0 || !/^[a-f0-9]{64}$/.test(id)) throw new Error("FIXTURE_LOCK_RESERVATION_FAILED");
      knownId = id; state = "confirmed";
    },
    async cleanup() {
      if (state === "removed") return;
      const listed = await command(["container", "ls", "--all", "--no-trunc", "--filter", `name=^/${name}$`, "--format", "{{.ID}}"]);
      if (listed.code !== 0) throw new Error("FIXTURE_LOCK_CLEANUP_UNKNOWN");
      const ids = listed.stdout.trim().split(/\s+/).filter(Boolean);
      if (!ids.length) {
        if (state === "unknown") throw new Error("FIXTURE_LOCK_ABSENT_AFTER_UNKNOWN_CREATE");
        state = "removed"; return;
      }
      if (ids.length !== 1 || !/^[a-f0-9]{64}$/.test(ids[0]) || (knownId && ids[0] !== knownId)) throw new Error("FIXTURE_LOCK_OWNERSHIP_INVALID");
      const format = `{"id":{{json .Id}},"name":{{json .Name}},"owner":{{json (index .Config.Labels "${ownerLabel}")}},"project":{{json (index .Config.Labels "rimo.backup.project")}}}`;
      const inspected = await command(["inspect", "--type", "container", "--format", format, ids[0]]);
      if (inspected.code !== 0) throw new Error("FIXTURE_LOCK_CLEANUP_UNKNOWN");
      const row = JSON.parse(inspected.stdout);
      if (row.id !== ids[0] || row.name !== `/${name}` || row.owner !== owner || row.project !== project) throw new Error("FIXTURE_LOCK_OWNERSHIP_INVALID");
      const removed = await command(["rm", row.id]);
      if (removed.code !== 0) throw new Error("FIXTURE_LOCK_CLEANUP_UNKNOWN");
      state = "removed";
    },
  };
}

export interface ResticRoundtripEvidence {
  stage?: string;
  version?: string;
  snapshotID?: string;
  sourceCreatedAt?: string;
  files?: Record<string, { bytes: number; sha256: string }>;
  checks: Record<string, boolean>;
}

interface FreshSnapshotReport {
  complete: true;
  status: "fresh";
  snapshotID: string;
  sourceCreatedAt: string;
  dataVerified: boolean;
  encrypted: boolean;
  offsiteVerified: boolean;
}

function isFreshSnapshotReport(report: unknown): report is FreshSnapshotReport {
  return typeof report === "object" && report !== null &&
    "complete" in report && report.complete === true && "status" in report && report.status === "fresh" &&
    "snapshotID" in report && typeof report.snapshotID === "string" && SNAPSHOT_ID.test(report.snapshotID) &&
    "sourceCreatedAt" in report && typeof report.sourceCreatedAt === "string" && Number.isFinite(Date.parse(report.sourceCreatedAt)) &&
    "dataVerified" in report && typeof report.dataVerified === "boolean" &&
    "encrypted" in report && typeof report.encrypted === "boolean" &&
    "offsiteVerified" in report && typeof report.offsiteVerified === "boolean";
}

async function restoredBackupDirectory(restoreRoot: string): Promise<string> {
  const root = await realpath(restoreRoot);
  const queue = [root]; const matches: string[] = [];
  let inspected = 0; let entries = 0;
  while (queue.length) {
    const directory = queue.shift()!;
    if (++inspected > 100 || (directory !== root && !directory.startsWith(`${root}${path.sep}`))) throw new Error("RESTIC_RESTORE_TREE_INVALID");
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (++entries > 200 || entry.isSymbolicLink()) throw new Error("RESTIC_RESTORE_TREE_INVALID");
      const filename = path.join(directory, entry.name);
      const resolved = await realpath(filename);
      if (!resolved.startsWith(`${root}${path.sep}`)) throw new Error("RESTIC_RESTORE_PATH_INVALID");
      if (entry.isDirectory()) queue.push(resolved);
      else if (entry.isFile() && entry.name === "manifest.json") matches.push(directory);
      else if (!entry.isFile()) throw new Error("RESTIC_RESTORE_FILE_INVALID");
    }
  }
  if (matches.length !== 1) throw new Error("RESTIC_RESTORED_MANIFEST_NOT_UNIQUE");
  return matches[0];
}

export async function resticComposeRoundtrip(options: {
  directory: string; input: string; project: string; signal: AbortSignal; evidence: ResticRoundtripEvidence;
}): Promise<string> {
  const { directory, input, project, signal, evidence } = options;
  const ownRoot = await realpath(directory);
  if (!(await lstat(ownRoot)).isDirectory() || !path.resolve(input).startsWith(`${ownRoot}${path.sep}`)) throw new Error("RESTIC_FIXTURE_PATH_INVALID");
  const original = await readBackupManifest(input);
  evidence.files = Object.fromEntries(["database.dump", "assets.tar"].map(name => [name,
    { bytes: original.files[name].bytes, sha256: original.files[name].sha256 }]));
  evidence.stage = "credentials-and-version";
  const passwordFile = path.join(ownRoot, "restic-password");
  await writeFile(passwordFile, randomBytes(48).toString("base64url"), { mode: 0o600, flag: "wx" });
  const environment: NodeJS.ProcessEnv = { ...process.env };
  for (const name of Object.keys(environment)) if (name.toUpperCase().startsWith("RESTIC_")) delete environment[name];
  Object.assign(environment, { RESTIC_REPOSITORY: path.join(ownRoot, "restic-repository"), RESTIC_PASSWORD_FILE: passwordFile,
    RESTIC_CACHE_DIR: path.join(ownRoot, "restic-cache") });
  await mkdir(environment.RESTIC_CACHE_DIR!, { recursive: true });
  const version = await fixtureCommand("restic", ["version"], environment, undefined, { signal, timeoutMs: 10_000 });
  const parsedVersion = /^restic (\d+\.\d+\.\d+)\b/.exec(version.stdout)?.[1];
  if (version.code !== 0 || parsedVersion !== "0.19.1") throw new Error("RESTIC_FIXTURE_VERSION_UNEXPECTED");
  evidence.version = parsedVersion;
  const run: typeof runRestic = (args, env, runSignal, timeout) => runRestic(args, env, runSignal, Math.min(timeout ?? 60_000, 60_000));
  const command = async (args: string[]): Promise<string> => {
    const result = await run(args, environment, signal, 60_000);
    if (result.exitCode !== 0 || result.signal !== null) throw new Error("RESTIC_FIXTURE_COMMAND_FAILED");
    return result.stdout;
  };
  evidence.stage = "repository-init";
  await command(["init", "--json"]); evidence.checks.repositoryInitialized = true;
  evidence.stage = "service-backup-and-read-data";
  const copied = await performRestic({ input, project, checkAge: false }, environment, { signal, run });
  const copiedReport = copied.report;
  if (copied.exitCode !== 0 || !isFreshSnapshotReport(copiedReport) || copiedReport.dataVerified !== true) {
    evidence.checks.backupFreshAndDataChecked = false;
    throw new Error("RESTIC_SERVICE_BACKUP_FAILED");
  }
  evidence.checks.backupFreshAndDataChecked = true;
  const snapshotID = copiedReport.snapshotID;
  evidence.snapshotID = snapshotID; evidence.sourceCreatedAt = copiedReport.sourceCreatedAt;
  evidence.stage = "fresh-age-and-exact-snapshot";
  const age = await performRestic({ project, checkAge: true }, environment, { signal, run });
  const ageReport = age.report;
  if (age.exitCode !== 0 || !isFreshSnapshotReport(ageReport) || ageReport.snapshotID !== snapshotID ||
      ageReport.sourceCreatedAt !== (original.capturedAt ?? original.createdAt)) {
    evidence.checks.freshAgeExactSnapshot = false;
    throw new Error("RESTIC_SERVICE_AGE_FAILED");
  }
  evidence.checks.freshAgeExactSnapshot = true;
  evidence.checks.localEncryptedRepositoryOnly = copiedReport.encrypted === true && copiedReport.offsiteVerified === false && ageReport.offsiteVerified === false;
  if (!evidence.checks.localEncryptedRepositoryOnly) throw new Error("RESTIC_SERVICE_AGE_FAILED");
  const restoreRoot = path.join(ownRoot, "restic-restored");
  evidence.stage = "restore-verify";
  await command(["restore", snapshotID, "--target", restoreRoot, "--verify", "--json"]);
  evidence.checks.restoreVerifyCommand = true;
  evidence.stage = "restored-manifest-and-hashes";
  const restored = await restoredBackupDirectory(restoreRoot);
  const manifest = await readBackupManifest(restored);
  evidence.checks.restoredManifestAndHashes = JSON.stringify(manifest) === JSON.stringify(original);
  if (!evidence.checks.restoredManifestAndHashes) throw new Error("RESTIC_SERVICE_HASH_MISMATCH");
  evidence.stage = "verified";
  return restored;
}
