import { hostname } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { interruptController } from "./backup-common.mjs";
import { CLOCK_SKEW_MS, COMMAND_TIMEOUT_MS, METADATA_TIMEOUT_MS, ResticFailure,
  readSnapshots, readSummary, resticEnvironment, resticOptions, runRestic, SNAPSHOT_ID, verifyLocalBackup,
  snapshotSourceTime, sourceFreshness, sourceTag } from "./restic-common.mjs";

/**
 * @param {{input?: string, project: string, checkAge?: boolean}} options
 * @param {Record<string, string | undefined>} environment
 * @param {{run?: typeof runRestic, verify?: typeof verifyLocalBackup, clock?: () => number, host?: string, signal?: AbortSignal}} [dependencies]
 */
export async function performRestic(options, environment, {
  run = runRestic, verify = verifyLocalBackup, clock = Date.now, host = hostname(), signal,
} = {}) {
  let stage = "credentials";
  let knownSnapshotId;
  try {
    const env = await resticEnvironment(environment);
    const tag = `rimo-service:${options.project}`;
    const filters = ["--host", host, "--tag", tag];
    const command = async (args, timeout = METADATA_TIMEOUT_MS) => {
      signal?.throwIfAborted();
      const result = await run(args, env, signal, timeout);
      if (result.exitCode !== 0 || result.signal !== null) throw new ResticFailure("RESTIC_EXIT_FAILED");
      return result.stdout;
    };
    if (options.checkAge) {
      stage = "age";
      const snapshots = readSnapshots(await command(["snapshots", "--json", ...filters]));
      const matching = snapshots.filter(item => item.hostname === host && item.tags.includes(tag))
        .map(snapshot => ({ snapshot, sourceTime: snapshotSourceTime(snapshot, tag) }));
      const latest = matching.sort((a, b) => b.sourceTime - a.sourceTime)[0];
      const freshness = latest ? sourceFreshness(latest.sourceTime, clock()) : { status: "missing" };
      const { status } = freshness;
      return { exitCode: status === "fresh" ? 0 : 1, report: { complete: true, mode: "check-age", status,
        ...(latest ? { snapshotID: latest.snapshot.id, createdAt: new Date(latest.snapshot.time).toISOString(),
          sourceCreatedAt: new Date(latest.sourceTime).toISOString(), ageSeconds: freshness.ageSeconds } : {}),
        encrypted: true, dataVerified: false, offsiteVerified: false } };
    }
    stage = "input";
    const local = await verify(options.input, options.project, signal);
    const sourceTime = Date.parse(local.manifest.capturedAt ?? local.manifest.createdAt);
    const capturedTag = sourceTag(sourceTime);
    stage = "backup";
    const started = clock();
    const backup = await run(["backup", "--json", ...filters, "--tag", capturedTag, "--", local.directory], env, signal, COMMAND_TIMEOUT_MS);
    const ended = clock();
    const summary = readSummary(backup.stdout, { allowErrors: backup.exitCode !== 0 || backup.signal !== null });
    if (typeof summary.snapshot_id === "string" && SNAPSHOT_ID.test(summary.snapshot_id)) knownSnapshotId = summary.snapshot_id;
    if (backup.exitCode !== 0 || backup.signal !== null) throw new ResticFailure("RESTIC_EXIT_FAILED");
    if (!knownSnapshotId || summary.dry_run === true) throw new ResticFailure("NO_NEW_SNAPSHOT");
    stage = "snapshot";
    const rows = readSnapshots(await command(["snapshots", "--json", ...filters, knownSnapshotId]));
    const snapshot = rows[0];
    const timestamp = Date.parse(snapshot?.time);
    if (rows.length !== 1 || snapshot.id !== knownSnapshotId || snapshot.hostname !== host ||
        snapshotSourceTime(snapshot, tag) !== sourceTime || snapshot.paths.length !== 1 ||
        snapshot.paths[0] !== local.directory || timestamp < started - CLOCK_SKEW_MS || timestamp > ended + CLOCK_SKEW_MS || ended < started) {
      throw new ResticFailure("SNAPSHOT_MISMATCH");
    }
    stage = "input-recheck";
    const unchanged = await verify(local.directory, options.project, signal);
    if (JSON.stringify(unchanged.manifest) !== JSON.stringify(local.manifest)) throw new ResticFailure("LOCAL_BACKUP_CHANGED");
    stage = "check";
    const checked = readSummary(await command(["check", "--json", "--read-data"], COMMAND_TIMEOUT_MS));
    if (checked.num_errors !== 0) throw new ResticFailure("RESTIC_CHECK_FAILED");
    const freshness = sourceFreshness(sourceTime, clock());
    return { exitCode: freshness.status === "fresh" ? 0 : 1, report: { complete: true, mode: "backup", snapshotID: knownSnapshotId,
      createdAt: new Date(timestamp).toISOString(), sourceCreatedAt: new Date(sourceTime).toISOString(), ...freshness,
      encrypted: true, dataVerified: true, offsiteVerified: false } };
  } catch (error) {
    return { exitCode: 2, report: { complete: false, stage,
      errorCode: error instanceof ResticFailure ? error.code : signal?.aborted ? "CANCELLED" : "OPERATION_FAILED",
      ...(knownSnapshotId ? { knownSnapshotId } : {}), dataVerified: false, offsiteVerified: false } };
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const interruption = interruptController();
  try {
    const result = await performRestic(resticOptions(process.argv.slice(2)), process.env, { signal: interruption.signal });
    process.stdout.write(`${JSON.stringify(result.report)}\n`);
    process.exitCode = result.exitCode;
  } catch {
    process.stdout.write(`${JSON.stringify({ complete: false, stage: "options", errorCode: "INVALID_OPTIONS" })}\n`);
    process.exitCode = 2;
  } finally { interruption.dispose(); }
}
