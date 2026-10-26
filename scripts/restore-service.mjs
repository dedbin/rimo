import path from "node:path";

import { acquireBackupLock, assertFreshProject, composeContext, log, options, readBackupManifest, RESTORE } from "./backup-common.mjs";

async function main() {
  const values = options("restore");
  if (!values.input) throw new Error("Specify --input with a service backup directory");
  const input = path.resolve(values.input);
  const manifest = await readBackupManifest(input);
  const context = await composeContext(values);
  const releaseLock = await acquireBackupLock(context, values.project);
  try {
    await assertFreshProject(context, values.project);
    log("restore_database_starting", { project: values.project });
    await context.run(["up", "--detach", "--wait", "--wait-timeout", "90", "db"]);
    const version = (await context.run(["exec", "-T", "db", "pg_restore", "--version"])).match(/PostgreSQL\) (\d+)/);
    if (!version || Number(version[1]) !== manifest.postgresMajor) throw new Error("Restore requires the same PostgreSQL major version as the backup");
    await context.fromFile(["exec", "-T", "db", "sh", "-c", RESTORE], path.join(input, "database.dump"));
    const storage = context.config.services.app.environment.ASSET_STORAGE_PATH ?? "/app/data/assets";
    log("restore_assets");
    await context.fromFile([
      "run", "--rm", "--no-deps", "-T", "--entrypoint", "tar", "app",
      "--no-same-owner", "-xf", "-", "-C", storage,
    ], path.join(input, "assets.tar"));
    log("restore_starting_service");
    await context.run(["up", "--detach", "--wait", "--wait-timeout", "120"]);
    log("restore_completed", { project: values.project, backupCreatedAt: manifest.createdAt });
  } finally { await releaseLock(); }
}

main().catch((error) => {
  log("restore_failed", { message: error instanceof Error ? error.message : "Unknown error" });
  process.exitCode = 1;
});
