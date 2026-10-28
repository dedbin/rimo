import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";

export const POSTGRES_FILLER = "/var/lib/postgresql/.resource-filler";
export const FILL_POSTGRES_SQL = `COPY (SELECT repeat('f',65535) FROM generate_series(1,4096)) TO '${POSTGRES_FILLER}';`;

export interface DockerResult {
  readonly code: number;
  readonly stdout: Buffer;
  readonly stderr: Buffer;
}

export interface PostgresResource {
  readonly project: string;
  readonly args: readonly string[];
  readonly environment: NodeJS.ProcessEnv;
  run(args: readonly string[], options?: { input?: Buffer; timeoutMs?: number; allowFailure?: boolean }): Promise<DockerResult>;
  sql(statement: string, allowFailure?: boolean): Promise<DockerResult>;
}

export async function runResourceDocker(
  args: readonly string[], environment: NodeJS.ProcessEnv,
  options: { input?: Buffer; timeoutMs?: number; allowFailure?: boolean } = {},
): Promise<DockerResult> {
  return new Promise((resolve, reject) => {
    const child = spawn("docker", [...args], { env: environment, stdio: ["pipe", "pipe", "pipe"], shell: false, windowsHide: true });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let size = 0;
    let failure: Error | undefined;
    const terminate = (reason: string): void => { failure = new Error(reason); child.kill("SIGKILL"); };
    const timer = setTimeout(() => terminate("PostgreSQL resource command deadline exceeded"), options.timeoutMs ?? 30_000);
    const collect = (target: Buffer[], chunk: Buffer): void => {
      size += chunk.length;
      if (size > 524_288) terminate("PostgreSQL resource command output limit exceeded");
      else target.push(chunk);
    };
    child.stdout.on("data", (chunk: Buffer) => collect(stdout, chunk));
    child.stderr.on("data", (chunk: Buffer) => collect(stderr, chunk));
    child.stdin.on("error", () => undefined);
    child.once("error", (error) => { clearTimeout(timer); reject(new Error(`Docker resource spawn failed: ${error.name}`)); });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (failure) return reject(failure);
      const result = { code: code ?? 1, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) };
      if (result.code !== 0 && !options.allowFailure) return reject(new Error(`Docker resource command failed (${result.code})`));
      resolve(result);
    });
    child.stdin.end(options.input);
  });
}

function assertProject(project: string): void {
  if (!/^rimo-pg-resource-[a-f0-9]{16}$/.test(project)) throw new Error("Unsafe PostgreSQL resource project");
}

async function installFixtureWebSocket(context: PostgresResource): Promise<void> {
  const require = createRequire(path.resolve("package.json"));
  const source = path.dirname(require.resolve("ws/package.json"));
  const names = ["package.json", "index.js", "wrapper.mjs", ...(await readdir(path.join(source, "lib"))).filter((name) => /^[a-z0-9-]+\.js$/.test(name)).map((name) => `lib/${name}`)];
  const files = Object.fromEntries(await Promise.all(names.map(async (name) => [name, (await readFile(path.join(source, name))).toString("base64")])));
  const installer = String.raw`
    (async()=>{
      const fs=require('node:fs/promises');
      const chunks=[];
      let size=0;
      for await(const chunk of process.stdin){size+=chunk.length;if(size>1048576)throw Error('Fixture dependency limit');chunks.push(chunk);}
      const files=JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const root='/tmp/pg-resource-ws';
      await fs.mkdir(root);
      await fs.mkdir(root+'/lib');
      for(const [name,encoded] of Object.entries(files)){
        if(!/^(package\.json|index\.js|wrapper\.mjs|lib\/[a-z0-9-]+\.js)$/.test(name))throw Error('Invalid fixture dependency path');
        await fs.writeFile(root+'/'+name,Buffer.from(encoded,'base64'),{flag:'wx',mode:0o600});
      }
    })().catch(()=>{process.exitCode=1;});
  `;
  await context.run(["exec", "-T", "harness", "node", "-e", installer], { input: Buffer.from(JSON.stringify(files)) });
}

async function assertBoundaries(context: PostgresResource, withHarness: boolean): Promise<void> {
  const ids = (await context.run(["ps", "--all", "--quiet"])).stdout.toString("utf8").trim().split(/\s+/);
  if (ids.length !== (withHarness ? 2 : 1) || ids.some((id) => !/^[a-f0-9]{64}$/.test(id))) throw new Error("Unexpected isolated PostgreSQL containers");
  for (const id of ids) {
    const format = '{{json (index .Config.Labels "com.docker.compose.project")}}|{{json (index .Config.Labels "com.docker.compose.service")}}|{{json .Mounts}}|{{json .HostConfig.Tmpfs}}|{{json .NetworkSettings.Ports}}|{{json .NetworkSettings.Networks}}';
    const output = await runResourceDocker(["inspect", "--format", format, id], context.environment);
    const [project, service, mounts, tmpfs, ports, networks] = output.stdout.toString("utf8").trim().split("|");
    if (JSON.parse(project) !== context.project) throw new Error("PostgreSQL resource ownership mismatch");
    const name = JSON.parse(service) as string;
    if (!["db", "harness"].includes(name)) throw new Error("Unexpected PostgreSQL resource service");
    const resources = JSON.parse(mounts) as { Type: string }[];
    if (resources.some((mount) => mount.Type !== "tmpfs")) throw new Error("Host bind/volume is forbidden in PostgreSQL resource tests");
    const targets = Object.keys(JSON.parse(tmpfs) as Record<string, string>);
    if (targets.length !== 1 || targets[0] !== (name === "db" ? "/var/lib/postgresql" : "/tmp")) throw new Error("Unexpected PostgreSQL resource tmpfs");
    if (Object.values(JSON.parse(ports) as Record<string, unknown>).some((value) => value !== null)) throw new Error("Host ports are forbidden in PostgreSQL resource tests");
    if (Object.keys(JSON.parse(networks) as Record<string, unknown>).join() !== `${context.project}_private`) throw new Error("Unexpected PostgreSQL resource network");
  }
  const info = await runResourceDocker(["network", "inspect", `${context.project}_private`, "--format", "{{.Internal}}|{{json .Containers}}"], context.environment);
  const [internal, members] = info.stdout.toString("utf8").trim().split("|");
  if (internal !== "true" || Object.keys(JSON.parse(members) as Record<string, unknown>).sort().join() !== ids.sort().join()) throw new Error("PostgreSQL resource network is not closed");
  const fs = await context.run(["exec", "-T", "db", "stat", "-f", "-c", "%T %S %b", "/var/lib/postgresql"]);
  const [type, block, count] = fs.stdout.toString("utf8").trim().split(/\s+/);
  if (type !== "tmpfs" || Number(block) * Number(count) !== 134_217_728) throw new Error("PostgreSQL filler is restricted to its own 128 MiB tmpfs");
}

export async function withPostgresResource<T>(work: (context: PostgresResource) => Promise<T>, withHarness = false): Promise<T> {
  const root = path.resolve("temp", "pg-resource");
  await mkdir(root, { recursive: true });
  const directory = await mkdtemp(path.join(root, "run-"));
  const project = `rimo-pg-resource-${randomBytes(8).toString("hex")}`;
  assertProject(project);
  const environment: NodeJS.ProcessEnv = { ...process.env, DOCKER_CLI_HINTS: "false" };
  for (const key of Object.keys(environment)) if (key.startsWith("COMPOSE_")) delete environment[key];
  environment.PG_RESOURCE_PASSWORD = randomBytes(32).toString("base64url");
  const composeFile = path.join(directory, "compose.json");
  const envFile = path.join(directory, "empty.env");
  const args = ["compose", "--ansi", "never", "--project-name", project, "--project-directory", directory, "--env-file", envFile, "--file", composeFile];
  const context: PostgresResource = {
    project, args, environment,
    run: (command, options) => runResourceDocker([...args, ...command], environment, options),
    sql: (statement, allowFailure = false) => runResourceDocker([
      ...args, "exec", "-T", "db", "psql", "-qAtX", "--set=ON_ERROR_STOP=1", "--set=VERBOSITY=sqlstate", "--username=rimo", "--dbname=rimo", "--file=-",
    ], environment, { input: Buffer.from(statement), allowFailure }),
  };
  let ownsProject = false;
  try {
    const image = (await readFile(path.resolve("docker-compose.yml"), "utf8")).match(/image:\s+(postgres:18-[^\s]+@sha256:[a-f0-9]{64})/)?.[1];
    if (!image) throw new Error("Pinned PostgreSQL 18 image was not found");
    await writeFile(envFile, "", { mode: 0o600 });
    await writeFile(composeFile, JSON.stringify({
      services: {
        db: {
          image, user: "999:999", restart: "no", networks: ["private"],
          environment: { POSTGRES_DB: "rimo", POSTGRES_USER: "rimo", POSTGRES_PASSWORD: "${PG_RESOURCE_PASSWORD}", PGDATA: "/var/lib/postgresql/18/docker" },
          command: ["postgres", "-c", "shared_buffers=8MB", "-c", "max_connections=20", "-c", "max_wal_size=32MB", "-c", "min_wal_size=32MB", "-c", "checkpoint_timeout=1h", "-c", "autovacuum=off", "-c", "log_line_prefix=%e "],
          tmpfs: ["/var/lib/postgresql:size=134217728,uid=999,gid=999,mode=0700"],
          healthcheck: { test: ["CMD", "pg_isready", "-h", "127.0.0.1", "-U", "rimo", "-d", "rimo"], interval: "1s", timeout: "2s", retries: 30 },
          mem_limit: "384m", cpus: 0.5, pids_limit: 128, cap_drop: ["ALL"], security_opt: ["no-new-privileges:true"],
        },
        ...(withHarness ? { harness: {
          image: "rimo:local", user: "1000:1000", restart: "no", networks: ["private"],
          command: ["node", "-e", "setTimeout(()=>process.exit(124),180000)"],
          environment: { DATABASE_URL: "postgresql://rimo:${PG_RESOURCE_PASSWORD}@db:5432/rimo" },
          tmpfs: ["/tmp:size=16777216,mode=1777"],
          mem_limit: "512m", cpus: 0.5, pids_limit: 128, cap_drop: ["ALL"], security_opt: ["no-new-privileges:true"],
        } } : {}),
      }, networks: { private: { internal: true } },
    }, null, 2), { mode: 0o600 });
    for (const kind of ["container", "network", "volume"]) {
      const check = await runResourceDocker([kind === "container" ? "ps" : kind, ...(kind === "container" ? ["--all"] : ["ls"]), "--filter", `label=com.docker.compose.project=${project}`, "--quiet"], environment);
      if (check.stdout.toString("utf8").trim()) throw new Error("Random PostgreSQL resource project already exists");
    }
    ownsProject = true;
    await context.run(["up", "--detach", "--no-build", "--pull", "never", "--wait", "--wait-timeout", "45", "db"], { timeoutMs: 60_000 });
    if (withHarness) await context.run(["up", "--detach", "--no-build", "--pull", "never", "--no-deps", "harness"]);
    await assertBoundaries(context, withHarness);
    if (withHarness) await installFixtureWebSocket(context);
    return await work(context);
  } finally {
    assertProject(project);
    if (ownsProject) await context.run(["down", "--volumes", "--timeout", "5"]);
    const target = path.resolve(directory);
    if (path.dirname(target) !== root || !path.basename(target).startsWith("run-")) throw new Error("Unsafe PostgreSQL resource cleanup path");
    await rm(target, { recursive: true, force: true });
    delete environment.PG_RESOURCE_PASSWORD;
  }
}
