// @vitest-environment node
import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import path from "node:path";
import { pathToFileURL } from "node:url";

import sharp from "sharp";
import { describe, expect, it } from "vitest";

import { acquireBackupLock, composeContext, parseComposeRows, readBackupManifest } from "../scripts/backup-common.mjs";

import { SEED, VERIFY } from "./backup-compose-fixtures";

async function port(): Promise<number> {
  const socket = createServer();
  await new Promise<void>((resolve) => socket.listen(0, "127.0.0.1", resolve));
  const address = socket.address();
  if (!address || typeof address === "string") throw new Error("No test port");
  await new Promise<void>((resolve, reject) => socket.close((error) => error ? reject(error) : resolve()));
  return address.port;
}

async function command(program: string, args: string[], environment: NodeJS.ProcessEnv, input?: string) {
  const child = spawn(program, args, { env: environment, stdio: ["pipe", "pipe", "pipe"], windowsHide: true, shell: false });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
  child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
  child.stdin.end(input);
  const code = await new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (value) => resolve(value ?? 1));
  });
  if (code !== 0 && !stdout.includes("backup_failed") && !stdout.includes("restore_failed")) {
    throw new Error(`Fixture command failed: ${stderr.slice(-3_000)}`);
  }
  return { code, stdout, stderr };
}

describe.skipIf(process.env.RIMO_TEST_DOCKER_BACKUP !== "1")("Compose service backup roundtrip", () => {
  it("restores PostgreSQL, files and owner access into fresh volumes and resumes writers after a failed backup", async () => {
    const root = path.resolve("temp");
    await mkdir(root, { recursive: true });
    const directory = await mkdtemp(path.join(root, "backup-compose-"));
    const suffix = randomUUID().slice(0, 8);
    const projects = [`rimo-backup-src-${suffix}`, `rimo-backup-dst-${suffix}`];
    const contexts: Awaited<ReturnType<typeof composeContext>>[] = [];
    try {
      for (const [index, project] of projects.entries()) {
        const httpPort = await port();
        const password = randomBytes(32).toString("base64url");
        const envFile = path.join(directory, `${index}.env`);
        await writeFile(envFile, [
          `POSTGRES_PASSWORD=${password}`, `DATABASE_URL=postgresql://rimo:${password}@db:5432/rimo`,
          `BETTER_AUTH_SECRET=${randomBytes(48).toString("base64url")}`, `BETTER_AUTH_URL=http://localhost:${httpPort}`,
          `PDF_WORKER_TOKEN=${randomBytes(48).toString("base64url")}`,
          `COLLABORATION_PUBLIC_URL=ws://localhost:${httpPort}/collaboration`, "APP_DOMAIN=http://localhost",
          `HTTP_PORT=${httpPort}`, `HTTPS_PORT=${await port()}`, "RIMO_TAG=local", "",
        ].join("\n"), { mode: 0o600 });
        contexts.push(await composeContext({ project, "env-file": envFile, "compose-file": "docker-compose.yml" }));
      }
      const [source, destination] = contexts;
      await source.run(["up", "--detach", "--wait", "--wait-timeout", "120"]);
      const image = await sharp({ create: { width: 3, height: 2, channels: 4, background: "green" } }).webp().toBuffer();
      const fixture = { boardId: randomUUID(), assetId: randomUUID(), email: `backup-${suffix}@example.test`, password: randomBytes(24).toString("base64url"), image: image.toString("base64") };
      const seeded = await command("docker", [...source.args, "exec", "-T", "app", "node", "--import=tsx", "--input-type=module", "-e", SEED], source.environment, JSON.stringify(fixture));
      const expected = { ...fixture, ...JSON.parse(seeded.stdout.trim().split(/\r?\n/).at(-1)!) };
      const backup = path.join(directory, "backup");
      const releaseLock = await acquireBackupLock(source, projects[0]);
      try {
        const blocked = await command(process.execPath, ["scripts/backup-service.mjs", "--project", projects[0], "--env-file", path.join(directory, "0.env"), "--output", path.join(directory, "concurrent-backup")], process.env);
        expect(blocked.code).toBe(1);
        expect(blocked.stdout).toContain("another operation");
        const rows = parseComposeRows(await source.run(["ps", "--format", "json", "app", "collaboration"]));
        expect(rows).toHaveLength(2);
        expect(rows.every((row: { State: string }) => row.State === "running")).toBe(true);
      } finally { await releaseLock(); }
      const result = await command(process.execPath, ["scripts/backup-service.mjs", "--project", projects[0], "--env-file", path.join(directory, "0.env"), "--output", backup], process.env);
      expect(result.code, result.stderr).toBe(0);
      expect((await readBackupManifest(backup)).offsiteVerified).toBe(false);
      expect(parseComposeRows(await source.run(["ps", "--format", "json", "app", "collaboration"])).every((row: { State: string }) => row.State === "running")).toBe(true);
      const restored = await command(process.execPath, ["scripts/restore-service.mjs", "--project", projects[1], "--env-file", path.join(directory, "1.env"), "--input", backup], process.env);
      expect(restored.code, restored.stderr).toBe(0);
      const verified = await command("docker", [...destination.args, "exec", "-T", "app", "node", "--import=tsx", "--input-type=module", "-e", VERIFY], destination.environment, JSON.stringify(expected));
      expect(JSON.parse(verified.stdout.trim().split(/\r?\n/).at(-1)!)).toEqual({ board: true, state: true, asset: true, login: true, http: true });

      const overwrite = await command(process.execPath, ["scripts/restore-service.mjs", "--project", projects[1], "--env-file", path.join(directory, "1.env"), "--input", backup], process.env);
      expect(overwrite.code).toBe(1);
      expect(overwrite.stdout).toContain("new Compose project");

      // Emit the same Node signal event on Windows, where child.kill("SIGINT") terminates forcibly.
      const interruption = path.join(directory, "interrupt-backup.mjs");
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
    } finally {
      for (const [index, context] of contexts.entries()) {
        if (!/^rimo-backup-(src|dst)-[a-f0-9]{8}$/.test(projects[index])) throw new Error("Unexpected cleanup project");
        await context.run(["down", "--volumes", "--remove-orphans"]);
      }
      if (path.dirname(directory) !== root) throw new Error("Unexpected backup test directory");
      await rm(directory, { recursive: true, force: true });
    }
  }, 300_000);
});
