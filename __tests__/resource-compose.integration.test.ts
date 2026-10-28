// @vitest-environment node
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { ASSET_DISK_FAILURE } from "./resource-compose-fixtures";

interface CommandResult {
  readonly stdout: Buffer;
  readonly stderr: Buffer;
}

interface FailureReport {
  readonly fillerError: string;
  readonly sourceError: string;
  readonly sourceStatus: number;
  readonly failureMessageSafe: boolean;
  readonly failedHttpStatus: number;
  readonly failedRows: number;
  readonly filledBytes: number;
  readonly orphanFiles: readonly { readonly bytes: number }[];
  readonly recoveredRows: number;
  readonly recoveredHttpStatus: number;
  readonly decoded: boolean;
  readonly downloaded: boolean;
  readonly appHealthyWhileFull: boolean;
  readonly appHealthyAfterRetry: boolean;
}

async function command(args: readonly string[], secrets: readonly string[], timeoutMs = 30_000): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const environment: NodeJS.ProcessEnv = { ...process.env, DOCKER_CLI_HINTS: "false" };
    for (const key of ["POSTGRES_PASSWORD", "BETTER_AUTH_SECRET", "COMPOSE_FILE", "COMPOSE_PROJECT_NAME", "COMPOSE_PROFILES", "COMPOSE_ENV_FILES"]) {
      delete environment[key];
    }
    const child = spawn("docker", [...args], {
      env: environment,
      stdio: ["pipe", "pipe", "pipe"], shell: false, windowsHide: true,
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let outputBytes = 0;
    let failure: Error | undefined;
    const terminate = (message: string): void => { failure = new Error(message); child.kill("SIGKILL"); };
    const deadline = setTimeout(() => terminate("Isolated Docker command exceeded its deadline"), timeoutMs);
    const collect = (target: Buffer[], chunk: Buffer): void => {
      outputBytes += chunk.length;
      if (outputBytes > 262_144) terminate("Isolated Docker command exceeded its output limit");
      else target.push(chunk);
    };
    child.stdout.on("data", (chunk: Buffer) => collect(stdout, chunk));
    child.stderr.on("data", (chunk: Buffer) => collect(stderr, chunk));
    child.stdin.on("error", () => undefined);
    child.once("error", (error) => { clearTimeout(deadline); reject(error); });
    child.once("close", (code) => {
      clearTimeout(deadline);
      const result = { stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) };
      if (failure) return reject(failure);
      if (code === 0) return resolve(result);
      let detail = result.stderr.toString("utf8").slice(-3_000);
      for (const secret of secrets) detail = detail.replaceAll(secret, "[redacted]");
      reject(new Error(`Isolated Docker command failed (${code}): ${detail}`));
    });
    child.stdin.end();
  });
}

function assertOwnedProject(project: string): void {
  if (!/^rimo-resource-[a-f0-9]{16}$/.test(project)) throw new Error("Unsafe resource test project");
}

async function assertIsolation(compose: readonly string[], project: string, secrets: readonly string[]): Promise<void> {
  assertOwnedProject(project);
  const containers = (await command([...compose, "ps", "--all", "--quiet"], secrets)).stdout.toString("utf8").trim().split(/\s+/);
  expect(containers).toHaveLength(2);
  for (const id of containers) {
    if (!/^[a-f0-9]{12,64}$/.test(id)) throw new Error("Invalid isolated container ID");
    const template = '{{json (index .Config.Labels "com.docker.compose.project")}}|{{json (index .Config.Labels "com.docker.compose.service")}}|{{json .Mounts}}|{{json .HostConfig.Tmpfs}}|{{json .NetworkSettings.Ports}}';
    const [label, service, mounts, tmpfs, ports] = (await command(["inspect", "--format", template, id], secrets)).stdout.toString("utf8").trim().split("|");
    expect(JSON.parse(label)).toBe(project);
    const resources = JSON.parse(mounts) as { Type: string; Destination: string }[];
    expect(resources.every((mount) => mount.Type === "tmpfs")).toBe(true);
    expect(["app", "db"]).toContain(JSON.parse(service));
    const expected = JSON.parse(service) === "app" ? ["/app/data/assets", "/tmp"] : ["/var/lib/postgresql"];
    expect(Object.keys(JSON.parse(tmpfs) as Record<string, string>).sort()).toEqual(expected.sort());
    expect(Object.values(JSON.parse(ports) as Record<string, unknown>).every((value) => value === null)).toBe(true);
  }
  const network = await command(["network", "inspect", `${project}_private`, "--format", "{{.Internal}}|{{json .Containers}}"], secrets);
  const [internal, members] = network.stdout.toString("utf8").trim().split("|");
  expect(internal).toBe("true");
  expect(Object.keys(JSON.parse(members) as Record<string, unknown>).sort()).toEqual([...containers].sort());
}

describe.skipIf(process.env.RIMO_TEST_DOCKER_RESOURCES !== "1")("isolated Compose filesystem failures", () => {
  it("rejects ENOSPC uploads without rows, stays healthy, and decodes/serves a successful retry", async () => {
    const root = path.resolve("temp");
    await mkdir(root, { recursive: true });
    const directory = await mkdtemp(path.join(root, "resource-compose-"));
    const project = `rimo-resource-${randomBytes(8).toString("hex")}`;
    assertOwnedProject(project);
    const password = randomBytes(32).toString("base64url");
    const authSecret = randomBytes(48).toString("base64url");
    const secrets = [password, authSecret];
    const composeFile = path.join(directory, "compose.json");
    const envFile = path.join(directory, ".env");
    const compose = ["compose", "--ansi", "never", "--project-name", project, "--project-directory", directory, "--env-file", envFile, "--file", composeFile];
    let ownsProject = false;
    try {
      const productionCompose = await readFile(path.resolve("docker-compose.yml"), "utf8");
      const postgresImage = productionCompose.match(/image:\s+(postgres:18-[^\s]+@sha256:[a-f0-9]{64})/)?.[1];
      if (!postgresImage) throw new Error("Pinned PostgreSQL 18 image was not found");
      await writeFile(envFile, `POSTGRES_PASSWORD=${password}\nBETTER_AUTH_SECRET=${authSecret}\n`, { mode: 0o600 });
      await writeFile(composeFile, JSON.stringify({
        services: {
          db: {
            image: postgresImage, user: "999:999", restart: "no", networks: ["private"],
            environment: { POSTGRES_DB: "rimo", POSTGRES_USER: "rimo", POSTGRES_PASSWORD: "${POSTGRES_PASSWORD}", PGDATA: "/var/lib/postgresql/18/docker" },
            command: ["postgres", "-c", "shared_buffers=16MB", "-c", "max_connections=20", "-c", "max_wal_size=64MB"],
            tmpfs: ["/var/lib/postgresql:size=268435456,uid=999,gid=999,mode=0700"],
            healthcheck: { test: ["CMD", "pg_isready", "-h", "127.0.0.1", "-U", "rimo", "-d", "rimo"], interval: "1s", timeout: "2s", retries: 30 },
            mem_limit: "256m", cpus: 0.5, pids_limit: 128,
            cap_drop: ["ALL"], security_opt: ["no-new-privileges:true"],
          },
          app: {
            image: "rimo:local", user: "1000:1000", restart: "no", networks: ["private"],
            environment: {
              DATABASE_URL: "postgresql://rimo:${POSTGRES_PASSWORD}@db:5432/rimo",
              BETTER_AUTH_SECRET: "${BETTER_AUTH_SECRET}", BETTER_AUTH_URL: "http://localhost:3000",
              NEXT_PUBLIC_COLLABORATION_URL: "ws://localhost:1234", ASSET_STORAGE_PATH: "/app/data/assets",
            },
            tmpfs: ["/app/data/assets:size=1048576,uid=1000,gid=1000,mode=0700", "/tmp:size=16777216,mode=1777"],
            mem_limit: "512m", cpus: 0.5, pids_limit: 128,
            cap_drop: ["ALL"], security_opt: ["no-new-privileges:true"],
          },
        },
        networks: { private: { internal: true } },
      }, null, 2), { mode: 0o600 });
      await command([...compose, "config", "--quiet"], secrets);
      const existing = await command(["ps", "--all", "--filter", `label=com.docker.compose.project=${project}`, "--quiet"], secrets);
      expect(existing.stdout.toString("utf8").trim(), "Random test project already exists").toBe("");
      const networks = await command(["network", "ls", "--filter", `label=com.docker.compose.project=${project}`, "--quiet"], secrets);
      expect(networks.stdout.toString("utf8").trim(), "Random test project network already exists").toBe("");
      ownsProject = true;
      await command([...compose, "up", "--detach", "--pull", "never", "--no-build", "--wait", "--wait-timeout", "45", "db"], secrets, 60_000);
      await command([...compose, "up", "--detach", "--pull", "never", "--no-build", "--no-deps", "app"], secrets);
      await assertIsolation(compose, project, secrets);
      const result = await command([...compose, "exec", "-T", "app", "node", "--import=tsx", "--input-type=module", "-e", ASSET_DISK_FAILURE], secrets, 60_000);
      const report = JSON.parse(result.stdout.toString("utf8").trim().split(/\r?\n/).at(-1)!) as FailureReport;
      expect(report).toMatchObject({
        fillerError: "ENOSPC", sourceError: "STORAGE_FULL", sourceStatus: 507,
        failedHttpStatus: 507, failureMessageSafe: true, failedRows: 0,
        recoveredRows: 1, recoveredHttpStatus: 201, decoded: true, downloaded: true,
        appHealthyWhileFull: true, appHealthyAfterRetry: true,
      });
      expect(report.filledBytes).toBe(1_048_576);
      expect(report.orphanFiles.every((file) => file.bytes >= 0)).toBe(true);
      await assertIsolation(compose, project, secrets);
      process.stdout.write(`${JSON.stringify({ test: "resource_assets_tmpfs", ...report })}\n`);
    } finally {
      assertOwnedProject(project);
      if (ownsProject) await command([...compose, "down", "--volumes", "--timeout", "5"], secrets, 30_000);
      const target = path.resolve(directory);
      if (path.dirname(target) !== root || !path.basename(target).startsWith("resource-compose-")) throw new Error("Unsafe resource test cleanup path");
      await rm(target, { recursive: true, force: true });
    }
  }, 180_000);
});
