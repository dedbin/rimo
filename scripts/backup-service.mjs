import { randomUUID } from "node:crypto";
import { access, mkdir, rename, rm, statfs, writeFile } from "node:fs/promises";
import path from "node:path";

import { acquireBackupLock, composeContext, DUMP, fileIntegrity, interruptController, log, options, runningWriters } from "./backup-common.mjs";

async function main() {
  const values = options("backup");
  const target = path.resolve(values.output ?? path.join("data", "backups", new Date().toISOString().replaceAll(":", "-")));
  if (await access(target).then(() => true, () => false)) throw new Error("Backup output already exists");
  const parent = path.dirname(target);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const disk = await statfs(parent);
  if (disk.bavail * disk.bsize < 2 * 1024 * 1024 * 1024) throw new Error("At least 2 GiB free space is required for backup staging");
  const stage = path.join(parent, `.rimo-backup-stage-${randomUUID()}`);
  await mkdir(stage, { mode: 0o700 });
  let context;
  let writers = [];
  let completed = false;
  let stopped = false;
  let releaseLock;
  const interruption = interruptController();
  const { signal } = interruption;
  try {
    context = await composeContext(values);
    signal.throwIfAborted();
    releaseLock = await acquireBackupLock(context, values.project);
    signal.throwIfAborted();
    writers = await runningWriters(context);
    signal.throwIfAborted();
    stopped = true;
    if (writers.length) {
      log("backup_pausing_writers", { project: values.project });
      await context.run(["stop", "--timeout", "30", ...writers]);
    }
    signal.throwIfAborted();
    const capturedAt = new Date().toISOString();
    const version = (await context.run(["exec", "-T", "db", "pg_dump", "--version"], signal)).match(/PostgreSQL\) (\d+)/);
    if (!version) throw new Error("Could not determine PostgreSQL version");
    log("backup_database");
    await context.toFile(["exec", "-T", "db", "sh", "-c", DUMP], path.join(stage, "database.dump"), signal);
    log("backup_assets");
    const storage = context.config.services.app.environment.ASSET_STORAGE_PATH ?? "/app/data/assets";
    await context.toFile([
      "run", "--rm", "--no-deps", "-T", "--entrypoint", "tar", "app",
      "--exclude=./.archive-work", "-cf", "-", "-C", storage, ".",
    ], path.join(stage, "assets.tar"), signal);
    const files = {};
    for (const filename of ["database.dump", "assets.tar"]) files[filename] = await fileIntegrity(path.join(stage, filename));
    signal.throwIfAborted();
    await writeFile(path.join(stage, "manifest.json"), `${JSON.stringify({
      format: "rimo-service-backup", version: 1, createdAt: new Date().toISOString(), capturedAt,
      postgresMajor: Number(version[1]), image: context.config.services.app.image,
      sourceProject: values.project, offsiteVerified: false, files,
    }, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    signal.throwIfAborted();
    await rename(stage, target);
    completed = true;
    log("backup_created", { project: values.project, directory: target });
  } finally {
    try {
      if (context && stopped && writers.length) {
        log("backup_resuming_writers", { project: values.project });
        await context.run(["start", ...writers]);
      }
    } finally {
      try {
        if (!completed) {
          if (path.dirname(stage) !== parent || !/^\.rimo-backup-stage-[a-f0-9-]{36}$/.test(path.basename(stage))) throw new Error("Unsafe backup staging path");
          await rm(stage, { recursive: true, force: true });
        }
      } finally {
        try { await releaseLock?.(); } finally { interruption.dispose(); }
      }
    }
  }
}

main().catch((error) => {
  log("backup_failed", { message: error instanceof Error ? error.message : "Unknown error" });
  process.exitCode = 1;
});
