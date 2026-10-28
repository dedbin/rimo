// @vitest-environment node
import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import path from "node:path";
import { pathToFileURL } from "node:url";

import sharp from "sharp";
import { describe, expect, it } from "vitest";

import { assertFreshStorage, parseComposeRows, readBackupManifest } from "../scripts/backup-common.mjs";

import { SEED, VERIFY } from "./backup-compose-fixtures";
import { acceptanceMetadata, monitorComposeChecks } from "./monitor-compose-checks";
import type { MonitorEvidence } from "./monitor-compose-checks";
import { fixtureCommand, fixtureContext, fixtureLock, resticComposeRoundtrip } from "./restic-compose-roundtrip";
import type { FixtureCommand, FixtureContext, ResticRoundtripEvidence } from "./restic-compose-roundtrip";

const resticEnabled = process.env.RIMO_TEST_RESTIC === "1";
const monitorEnabled = process.env.RIMO_TEST_DOCKER_MONITOR === "1";
const acceptanceEnabled = resticEnabled || monitorEnabled;
const operationBudgetMs = acceptanceEnabled ? 600_000 : 240_000;
const NODE_DEADLINE = "const fixtureDeadline=setTimeout(()=>process.exit(124),30000);fixtureDeadline.unref();\n";

interface AcceptanceReport {
  version: number; runId: string; kind: string; status: "running" | "complete" | "failed"; stage: string; startedAt: string;
  enabled: { restic: boolean; monitor: boolean }; node: string; projects: string[];
  metadata: Record<string, Awaited<ReturnType<typeof acceptanceMetadata>>>;
  restic: ResticRoundtripEvidence; monitor: MonitorEvidence; checks: Record<string, boolean>;
  cleanup: Record<string, boolean>; durationMs?: number; errorCode?: string;
}

async function port(): Promise<number> {
  const socket = createServer();
  await new Promise<void>((resolve) => socket.listen(0, "127.0.0.1", resolve));
  const address = socket.address();
  if (!address || typeof address === "string") throw new Error("No test port");
  await new Promise<void>((resolve, reject) => socket.close((error) => error ? reject(error) : resolve()));
  return address.port;
}

describe.skipIf(process.env.RIMO_TEST_DOCKER_BACKUP !== "1")("Compose service backup roundtrip", () => {
  it("restores PostgreSQL, files and owner access into fresh volumes and resumes writers after a failed backup", async () => {
    const root = path.resolve("temp");
    await mkdir(root, { recursive: true });
    const directory = await mkdtemp(path.join(root, "backup-compose-"));
    const runId = randomUUID();
    const suffix = runId.slice(0, 8);
    const projects = [`rimo-backup-src-${suffix}`, `rimo-backup-dst-${suffix}`];
    const contexts: FixtureContext[] = [];
    const ownedProjects = new Set<string>();
    const controller = new AbortController();
    const interrupt = (): void => controller.abort();
    const deadline = setTimeout(interrupt, operationBudgetMs);
    process.on("SIGINT", interrupt); process.on("SIGTERM", interrupt);
    const command: FixtureCommand = (program, args, environment, input, options = { signal: controller.signal }) =>
      fixtureCommand(program, args, environment, input, options);
    const report: AcceptanceReport = { version: 1, runId, kind: "service-restic-monitor-compose-acceptance", status: "running", stage: "setup",
      startedAt: new Date().toISOString(), enabled: { restic: resticEnabled, monitor: monitorEnabled }, node: process.versions.node,
      projects, metadata: {}, restic: { checks: {} }, monitor: { observations: [] }, checks: {}, cleanup: {} };
    const started = performance.now();
    let failed = false;
    let releaseLock: (() => Promise<void>) | undefined;
    try {
      for (const [index, project] of projects.entries()) {
        const httpPort = await port();
        const password = randomBytes(32).toString("base64url");
        const envFile = path.join(directory, `${index}.env`);
        await writeFile(envFile, [
          `POSTGRES_PASSWORD=${password}`, `DATABASE_URL=postgresql://rimo:${password}@db:5432/rimo`,
          `BETTER_AUTH_SECRET=${randomBytes(48).toString("base64url")}`, `BETTER_AUTH_URL=http://localhost:${httpPort}`,
          `PDF_WORKER_TOKEN=${randomBytes(48).toString("base64url")}`,
          `COLLABORATION_PUBLIC_URL=ws://localhost:${httpPort}/collaboration`, "APP_DOMAIN=http://localhost", "MAX_OWNERS=6",
          `HTTP_PORT=127.0.0.1:${httpPort}`, `HTTPS_PORT=127.0.0.1:${await port()}`, "RIMO_TAG=local", "",
        ].join("\n"), { mode: 0o600 });
        const context = await fixtureContext({ project, "env-file": envFile, "compose-file": "docker-compose.yml" }, controller.signal);
        contexts.push(context);
        assertFreshStorage(context.config, project);
        const containers = parseComposeRows(await context.run(["ps", "--all", "--format", "json"]));
        const volumes = await command("docker", ["volume", "ls", "--filter", `name=^${project}_`, "--format", "{{.Name}}"], context.environment);
        if (containers.length || volumes.code !== 0 || volumes.stdout.trim()) throw new Error("FIXTURE_PROJECT_NOT_FRESH");
        ownedProjects.add(project);
      }
      const [source, destination] = contexts;
      report.stage = "source-start";
      await source.run(["up", "--detach", "--no-build", "--wait", "--wait-timeout", "120"]);
      if (acceptanceEnabled) report.metadata.source = await acceptanceMetadata(source, command, controller.signal);
      report.stage = "seed";
      const image = await sharp({ create: { width: 3, height: 2, channels: 4, background: "green" } }).webp().toBuffer();
      const fixture = { boardId: randomUUID(), assetId: randomUUID(), email: `backup-${suffix}@example.test`, password: randomBytes(24).toString("base64url"), image: image.toString("base64") };
      const seeded = await command("docker", [...source.args, "exec", "-T", "app", "node", "--import=tsx", "--input-type=module", "-e", NODE_DEADLINE + SEED], source.environment, JSON.stringify(fixture));
      expect(seeded.code).toBe(0);
      const expected = { ...fixture, ...JSON.parse(seeded.stdout.trim().split(/\r?\n/).at(-1)!) };
      const backup = path.join(directory, "backup");
      report.stage = "concurrent-backup-lock";
      const lock = fixtureLock(source, projects[0], runId);
      releaseLock = lock.cleanup;
      await lock.create(controller.signal);
      try {
        const blocked = await command(process.execPath, ["scripts/backup-service.mjs", "--project", projects[0], "--env-file", path.join(directory, "0.env"), "--output", path.join(directory, "concurrent-backup")], process.env);
        expect(blocked.code).toBe(1);
        expect(blocked.stdout).toContain("another operation");
        const rows = parseComposeRows(await source.run(["ps", "--format", "json", "app", "collaboration"]));
        expect(rows).toHaveLength(2);
        expect(rows.every((row: { State: string }) => row.State === "running")).toBe(true);
      } finally { await lock.cleanup(); releaseLock = undefined; report.cleanup.backupLock = true; }
      report.stage = "local-service-backup";
      const result = await command(process.execPath, ["scripts/backup-service.mjs", "--project", projects[0], "--env-file", path.join(directory, "0.env"), "--output", backup], process.env);
      expect(result.code, result.stderr).toBe(0);
      expect((await readBackupManifest(backup)).offsiteVerified).toBe(false);
      report.checks.localServiceBackup = true;
      expect(parseComposeRows(await source.run(["ps", "--format", "json", "app", "collaboration"])).every((row: { State: string }) => row.State === "running")).toBe(true);
      report.stage = "restic-roundtrip";
      const restoreInput = resticEnabled ? await resticComposeRoundtrip({ directory, input: backup, project: projects[0], signal: controller.signal, evidence: report.restic }) : backup;
      report.stage = "fresh-service-restore";
      const restored = await command(process.execPath, ["scripts/restore-service.mjs", "--project", projects[1], "--env-file", path.join(directory, "1.env"), "--input", restoreInput], process.env);
      expect(restored.code, restored.stderr).toBe(0);
      if (acceptanceEnabled) report.metadata.destination = await acceptanceMetadata(destination, command, controller.signal);
      if (acceptanceEnabled) {
        report.checks.sameSourceAndDestinationImages = Object.entries(report.metadata.source.images)
          .every(([service, image]) => report.metadata.destination.images[service] === image);
        expect(report.checks.sameSourceAndDestinationImages).toBe(true);
      }
      report.stage = "restored-service-verification";
      const verified = await command("docker", [...destination.args, "exec", "-T", "app", "node", "--import=tsx", "--input-type=module", "-e", NODE_DEADLINE + VERIFY], destination.environment, JSON.stringify(expected));
      expect(verified.code).toBe(0);
      expect(JSON.parse(verified.stdout.trim().split(/\r?\n/).at(-1)!)).toEqual({ board: true, state: true, asset: true, login: true, http: true });
      report.checks.restoredDatabaseFilesLoginHttp = true;
      if (monitorEnabled) {
        report.stage = "monitor-faults";
        await monitorComposeChecks({ context: source, command, project: projects[0], envFile: path.join(directory, "0.env"),
          composeFile: path.resolve("docker-compose.yml"), signal: controller.signal, evidence: report.monitor });
        report.stage = "source-data-after-monitor-faults";
        const intact = await command("docker", [...source.args, "exec", "-T", "app", "node", "--import=tsx", "--input-type=module", "-e", NODE_DEADLINE + VERIFY], source.environment, JSON.stringify(expected));
        expect(intact.code).toBe(0);
        expect(JSON.parse(intact.stdout.trim().split(/\r?\n/).at(-1)!)).toEqual({ board: true, state: true, asset: true, login: true, http: true });
        report.checks.sourceDataAfterDatabaseRestart = true;
      }

      report.stage = "overwrite-guard";
      const overwrite = await command(process.execPath, ["scripts/restore-service.mjs", "--project", projects[1], "--env-file", path.join(directory, "1.env"), "--input", restoreInput], process.env);
      expect(overwrite.code).toBe(1);
      expect(overwrite.stdout).toContain("new Compose project");
      report.checks.overwriteGuard = true;

      // Emit the same Node signal event on Windows, where child.kill("SIGINT") terminates forcibly.
      const interruption = path.join(directory, "interrupt-backup.mjs");
      report.stage = "backup-interruption";
      await writeFile(interruption, [
        "const write = process.stdout.write.bind(process.stdout);",
        "process.stdout.write = (chunk, ...args) => {",
        "  const result = write(chunk, ...args);",
        "  if (String(chunk).includes('backup_pausing_writers')) queueMicrotask(() => process.emit('SIGINT'));",
        "  return result;",
        "};", "",
      ].join("\n"));
      const interrupted = await command(process.execPath, ["--import", pathToFileURL(interruption).href, "scripts/backup-service.mjs", "--project", projects[0], "--env-file", path.join(directory, "0.env"), "--output", path.join(directory, "interrupted-backup")], process.env);
      expect(interrupted.code).toBe(1);
      expect(interrupted.stdout).toContain("backup_resuming_writers");
      expect(interrupted.stdout).not.toContain('"event":"backup_database"');
      const resumed = parseComposeRows(await source.run(["ps", "--format", "json", "app", "collaboration"]));
      expect(resumed).toHaveLength(2);
      expect(resumed.every((row: { State: string }) => row.State === "running")).toBe(true);
      report.checks.interruptedBackupResumesWriters = true;

      report.stage = "backup-failure";
      const chmod = 'require("fs").chmodSync(require("path").join(process.env.ASSET_STORAGE_PATH,process.argv[1]+".webp"),Number(process.argv[2]))';
      await command("docker", [...source.args, "exec", "-T", "app", "node", "-e", chmod, fixture.assetId, "0"], source.environment);
      try {
        const failure = await command(process.execPath, ["scripts/backup-service.mjs", "--project", projects[0], "--env-file", path.join(directory, "0.env"), "--output", path.join(directory, "failed-backup")], process.env);
        expect(failure.code).toBe(1);
        expect(failure.stdout).toContain("backup_resuming_writers");
        const rows = parseComposeRows(await source.run(["ps", "--format", "json", "app", "collaboration"]));
        expect(rows).toHaveLength(2);
        expect(rows.every((row: { State: string }) => row.State === "running")).toBe(true);
      } finally {
        await command("docker", [...source.args, "exec", "-T", "app", "node", "-e", chmod, fixture.assetId, "384"], source.environment);
      }
      report.checks.failedBackupResumesWriters = true;
      report.stage = "verified";
    } catch {
      failed = true; report.errorCode = controller.signal.aborted ? "FIXTURE_INTERRUPTED_OR_DEADLINE" : "ACCEPTANCE_STAGE_FAILED";
    } finally {
      clearTimeout(deadline);
      const cleanupJobs = contexts.map(async (context, index) => {
        const project = projects[index];
        if (!/^rimo-backup-(src|dst)-[a-f0-9]{8}$/.test(project) || context.args[context.args.indexOf("--project-name") + 1] !== project) throw new Error("FIXTURE_CLEANUP_PROJECT_INVALID");
        if (!ownedProjects.has(project)) return;
        await context.run(["down", "--volumes", "--remove-orphans"], AbortSignal.timeout(90_000));
      });
      const lockCleanup = releaseLock;
      if (lockCleanup) cleanupJobs.push(lockCleanup());
      const cleanup = await Promise.allSettled(cleanupJobs);
      for (const [index, result] of cleanup.entries()) report.cleanup[index < contexts.length ? projects[index] : "backupLock"] = result.status === "fulfilled";
      if (cleanup.some(result => result.status === "rejected")) { failed = true; report.errorCode = "OWN_RESOURCE_CLEANUP_FAILED"; }
      try {
        if (path.dirname(path.resolve(directory)) !== root) throw new Error("FIXTURE_CLEANUP_PATH_INVALID");
        if (cleanup.every(result => result.status === "fulfilled") && report.cleanup.backupLock !== false) {
          await rm(directory, { recursive: true, force: true }); report.cleanup.privateDirectory = true;
        }
      } catch { failed = true; report.cleanup.privateDirectory = false; report.errorCode = "OWN_PATH_CLEANUP_FAILED"; }
      report.status = failed ? "failed" : "complete"; report.durationMs = Math.round(performance.now() - started);
      process.off("SIGINT", interrupt); process.off("SIGTERM", interrupt);
      if (acceptanceEnabled) {
        const reports = path.join(root, "operations-acceptance");
        await mkdir(reports, { recursive: true });
        const filename = path.join(reports, `${runId}.json`);
        await writeFile(filename, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600, flag: "wx" });
        process.stdout.write(`${JSON.stringify({ kind: report.kind, status: report.status, stage: report.stage, report: path.relative(process.cwd(), filename) })}\n`);
      }
    }
    if (failed) throw new Error(`ACCEPTANCE_FAILED_AT_${report.stage.replaceAll("-", "_").toUpperCase()}`);
  }, acceptanceEnabled ? 720_000 : 300_000);
});
