import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { parseArgs, parseEnv } from "node:util";

export function options(kind) {
  const { values } = parseArgs({ options: {
    project: { type: "string" }, "env-file": { type: "string", default: ".env" },
    "compose-file": { type: "string", default: "docker-compose.yml" },
    [kind === "backup" ? "output" : "input"]: { type: "string" },
  } });
  if (!values.project || !/^[a-z0-9][a-z0-9_-]{0,62}$/.test(values.project)) {
    throw new Error("Specify --project with an explicit Compose project name");
  }
  return values;
}

export function log(event, details = {}) {
  process.stdout.write(`${JSON.stringify({ event, ...details })}\n`);
}

function start(command, args, environment, signal) {
  return spawn(command, args, { env: environment, stdio: ["pipe", "pipe", "pipe"], windowsHide: true, shell: false, signal });
}

function completion(child) {
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => code === 0 ? resolve() : reject(new Error(`Command failed with exit code ${code}`)));
  });
}

export async function capture(command, args, environment, signal) {
  const child = start(command, args, environment, signal);
  child.stdin.end();
  child.stderr.pipe(process.stderr);
  const chunks = [];
  let bytes = 0;
  child.stdout.on("data", (chunk) => {
    bytes += chunk.byteLength;
    if (bytes > 8 * 1024 * 1024) child.kill();
    else chunks.push(chunk);
  });
  await completion(child);
  return Buffer.concat(chunks).toString("utf8");
}

export async function processToFile(command, args, environment, filename, signal) {
  const child = start(command, args, environment, signal);
  const done = completion(child);
  child.stdin.end();
  child.stderr.pipe(process.stderr);
  try {
    await Promise.all([done, pipeline(child.stdout, createWriteStream(filename, { flags: "wx", mode: 0o600 }))]);
  } catch (error) { child.kill(); throw error; }
}

export async function fileToProcess(command, args, environment, filename, signal) {
  const child = start(command, args, environment, signal);
  const done = completion(child);
  child.stdout.resume();
  child.stderr.pipe(process.stderr);
  try {
    await Promise.all([done, pipeline(createReadStream(filename), child.stdin)]);
  } catch (error) { child.kill(); throw error; }
}

export async function fileIntegrity(filename) {
  const hash = createHash("sha256");
  let bytes = 0;
  for await (const chunk of createReadStream(filename)) { bytes += chunk.byteLength; hash.update(chunk); }
  return { bytes, sha256: hash.digest("hex") };
}

export async function composeContext(values) {
  const composeFile = path.resolve(values["compose-file"]);
  const envFile = path.resolve(values["env-file"]);
  const environment = { ...process.env };
  // The explicit env file is authoritative, even when the calling Node process loaded another one.
  for (const name of Object.keys(parseEnv(await readFile(envFile, "utf8")))) delete environment[name];
  const args = ["compose", "--project-name", values.project, "--env-file", envFile, "--file", composeFile];
  const run = (command, signal) => capture("docker", [...args, ...command], environment, signal);
  const config = JSON.parse(await run(["config", "--format", "json"]));
  if (!config.services?.db || !config.services?.app || !config.services?.collaboration) {
    throw new Error("Expected db, app and collaboration services in the Compose project");
  }
  const database = new URL(config.services.app.environment.DATABASE_URL);
  if (database.hostname !== "db" || decodeURIComponent(database.pathname.slice(1)) !== config.services.db.environment.POSTGRES_DB) {
    throw new Error("Backup and restore require the local Compose db service");
  }
  return {
    args, environment, config, run,
    toFile: (command, filename, signal) => processToFile("docker", [...args, ...command], environment, filename, signal),
    fromFile: (command, filename, signal) => fileToProcess("docker", [...args, ...command], environment, filename, signal),
  };
}

export function interruptController() {
  const controller = new AbortController();
  const interrupt = () => controller.abort(new Error("Operation interrupted"));
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", interrupt);
  return {
    signal: controller.signal,
    dispose: () => { process.off("SIGINT", interrupt); process.off("SIGTERM", interrupt); },
  };
}

export async function acquireBackupLock(context, project) {
  if (!/^[a-z0-9][a-z0-9_-]{0,62}$/.test(project)) throw new Error("Invalid backup project");
  let id;
  try {
    id = (await capture("docker", [
      "create", "--name", `rimo-backup-lock-${project}`, "--label", `rimo.backup.project=${project}`,
      "--entrypoint", "node", context.config.services.app.image, "-e", "process.exit(0)",
    ], context.environment)).trim();
  } catch {
    throw new Error("Could not reserve backup operation; another operation or a stale backup lock may exist");
  }
  if (!/^[a-f0-9]{64}$/.test(id)) throw new Error("Docker returned an invalid backup lock identifier");
  let released = false;
  return async () => {
    if (released) return;
    await capture("docker", ["rm", id], context.environment);
    released = true;
  };
}

export function parseComposeRows(output) {
  const trimmed = output.trim();
  if (!trimmed) return [];
  if (trimmed.startsWith("[")) return JSON.parse(trimmed);
  return trimmed.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
}

export async function runningWriters(context) {
  const rows = parseComposeRows(await context.run(["ps", "--all", "--format", "json", "app", "collaboration"]));
  if (rows.some((row) => !["running", "restarting", "exited", "created"].includes(row.State))) {
    throw new Error("Backup requires writers to be running, restarting or stopped; resolve paused or unhealthy container states first");
  }
  return [...new Set(rows.filter((row) => ["running", "restarting"].includes(row.State)).map((row) => row.Service))];
}

export async function assertFreshProject(context, project) {
  assertFreshStorage(context.config, project);
  if (parseComposeRows(await context.run(["ps", "--all", "--format", "json"])).length) {
    throw new Error("Restore requires a new Compose project without existing containers");
  }
  const existing = new Set((await capture("docker", ["volume", "ls", "--format", "{{.Name}}"], context.environment)).trim().split(/\r?\n/));
  for (const key of ["postgres-data", "assets"]) {
    if (existing.has(context.config.volumes[key].name)) {
      throw new Error("Restore requires fresh project-scoped database and asset volumes");
    }
  }
}

export function assertFreshStorage(config, project) {
  const within = (parent, child) => child === parent || child.startsWith(`${parent.replace(/\/$/, "")}/`);
  const storage = config.services?.app?.environment?.ASSET_STORAGE_PATH ?? "/app/data/assets";
  if (typeof storage !== "string" || !path.posix.isAbsolute(storage) || storage !== path.posix.normalize(storage) || storage === "/") {
    throw new Error("Restore requires an explicit absolute asset storage directory");
  }
  for (const key of ["PGDATA", "POSTGRES_INITDB_WALDIR"]) {
    const directory = config.services?.db?.environment?.[key];
    if (directory !== undefined && (typeof directory !== "string" || !path.posix.isAbsolute(directory) ||
        !within("/var/lib/postgresql", path.posix.normalize(directory)))) {
      throw new Error("Restore requires PostgreSQL data and WAL directories inside the database volume");
    }
  }
  const initArgs = config.services?.db?.environment?.POSTGRES_INITDB_ARGS;
  if (initArgs !== undefined && initArgs !== "") throw new Error("Restore does not support custom PostgreSQL initialization arguments");
  for (const [serviceName, source, target] of [["db", "postgres-data", "/var/lib/postgresql"], ["app", "assets", storage]]) {
    const volume = config.volumes?.[source];
    if (!volume || volume.external || volume.name !== `${project}_${source}` ||
        (volume.driver && volume.driver !== "local") || Object.keys(volume.driver_opts ?? {}).length) {
      throw new Error("Restore requires fresh local volumes without driver options");
    }
    const service = config.services?.[serviceName];
    if (!service || service.volumes_from?.length || service.tmpfs?.length) {
      throw new Error("Restore cannot use inherited volumes or tmpfs for data services");
    }
    const mounts = service.volumes ?? [];
    const expected = mounts.filter((mount) => mount.type === "volume" && mount.source === source && mount.target === target);
    if (expected.length !== 1) throw new Error("Restore requires one named project-scoped mount for each data directory");
    for (const mount of mounts) {
      if (mount === expected[0]) continue;
      if (typeof mount.target !== "string" || !path.posix.isAbsolute(mount.target)) throw new Error("Restore encountered an invalid mount target");
      const destination = path.posix.normalize(mount.target);
      if (within(target, destination) || within(destination, target)) {
        throw new Error("Restore cannot use overlapping mounts for a data directory");
      }
    }
  }
}

export async function readBackupManifest(directory) {
  const bytes = await readFile(path.join(directory, "manifest.json"));
  if (bytes.byteLength > 65_536) throw new Error("Backup manifest is too large");
  const manifest = JSON.parse(bytes.toString("utf8"));
  if (manifest?.format !== "rimo-service-backup" || manifest.version !== 1 ||
      !Number.isFinite(Date.parse(manifest.createdAt)) || !Number.isInteger(manifest.postgresMajor) ||
      manifest.postgresMajor < 18) throw new Error("Unsupported service backup format");
  for (const filename of ["database.dump", "assets.tar"]) {
    const expected = manifest.files?.[filename];
    if (!expected || !Number.isSafeInteger(expected.bytes) || expected.bytes <= 0 || !/^[a-f0-9]{64}$/.test(expected.sha256)) {
      throw new Error("Invalid backup file descriptor");
    }
    const actual = await fileIntegrity(path.join(directory, filename));
    if (actual.bytes !== expected.bytes || actual.sha256 !== expected.sha256) throw new Error("Backup integrity check failed");
  }
  return manifest;
}

export const DUMP = 'PGPASSWORD="$POSTGRES_PASSWORD" exec pg_dump --format=custom --no-owner --no-acl --username="$POSTGRES_USER" --dbname="$POSTGRES_DB"';
export const RESTORE = 'PGPASSWORD="$POSTGRES_PASSWORD" exec pg_restore --exit-on-error --single-transaction --no-owner --no-acl --username="$POSTGRES_USER" --dbname="$POSTGRES_DB"';
