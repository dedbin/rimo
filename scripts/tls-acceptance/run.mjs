import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { request as httpsRequest } from "node:https";
import { connect as connectHttp2 } from "node:http2";
import { connect as connectTls } from "node:tls";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, promisify } from "node:util";

const repository = fileURLToPath(new URL("../../", import.meta.url));
const execute = promisify(execFile);

async function sourceEnvironment(signal) {
  const files = ["scripts/tls-acceptance/run.mjs", "scripts/tls-acceptance/browser.mjs", "docker-compose.yml", "config/chromium-seccomp.json"];
  const options = { cwd: repository, env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" }, timeout: 5_000, windowsHide: true, signal };
  const [commit, dirty, sources] = await Promise.all([
    execute("git", ["rev-parse", "HEAD"], options).then(({ stdout }) => stdout.trim(), () => null),
    execute("git", ["status", "--porcelain"], options).then(({ stdout }) => !!stdout.trim(), () => null),
    Promise.all(files.map(async (filename) => [filename, await readFile(path.join(repository, filename))])),
  ]);
  const hash = createHash("sha256");
  const sourceFiles = {};
  for (const [filename, bytes] of sources) {
    hash.update(filename); hash.update(bytes);
    sourceFiles[filename] = createHash("sha256").update(bytes).digest("hex");
  }
  return { recordedAt: new Date().toISOString(), commit, dirty, node: process.version, sourceSha256: hash.digest("hex"), sourceFiles };
}

export function createTlsLifecycle(report, deadlineMs = 360_000) {
  assert.ok(Number.isSafeInteger(deadlineMs) && deadlineMs > 0 && deadlineMs <= 360_000, "TLS_DEADLINE_INVALID");
  const controller = new AbortController();
  let interruption;
  const request = (reason) => {
    if (interruption) return;
    interruption = { reason, at: new Date().toISOString() };
    controller.abort(new Error(`TLS_INTERRUPTED_${reason.toUpperCase()}`));
  };
  const interrupt = () => request("SIGINT");
  const terminate = () => request("SIGTERM");
  process.on("SIGINT", interrupt); process.on("SIGTERM", terminate);
  const watchdog = setTimeout(() => request("deadline"), deadlineMs);
  return {
    signal: controller.signal,
    apply() {
      if (interruption) {
        report.interruption = interruption;
        report.status = report.cleanup === "failed" ? "cleanup-failed" : "interrupted";
      }
    },
    async finalize(write) {
      this.apply();
      const before = interruption;
      await write();
      if (before !== interruption) { this.apply(); await write(); }
      this.apply();
    },
    exitCode() { return report.cleanup === "failed" ? 1 : interruption ? interruption.reason === "SIGINT" ? 130 : interruption.reason === "SIGTERM" ? 143 : 124 : report.status === "passed" ? 0 : 1; },
    dispose() { clearTimeout(watchdog); process.off("SIGINT", interrupt); process.off("SIGTERM", terminate); },
  };
}

async function port() {
  const socket = createServer();
  await new Promise((resolve, reject) => { socket.once("error", reject); socket.listen(0, "127.0.0.1", resolve); });
  const value = socket.address().port;
  await new Promise((resolve, reject) => socket.close((error) => error ? reject(error) : resolve()));
  return value;
}

export function createDockerRunner(environment, signal, phase, program = "docker") {
  return async function docker(args, { input, timeout = 30_000, cleanup = false, relay = false } = {}) {
  if (signal.aborted && !cleanup) throw signal.reason;
  return new Promise((resolve, reject) => {
    const child = spawn(program, args, { env: environment, shell: false, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    const stdout = []; const stderr = [];
    let size = 0; let failure; let remainder = "";
    const stop = () => { failure = new Error("TLS_COMMAND_DEADLINE"); child.kill("SIGKILL"); };
    const timer = setTimeout(stop, timeout);
    if (!cleanup) signal.addEventListener("abort", stop, { once: true });
    const collect = (target, chunk) => { size += chunk.length; if (size > 524_288) stop(); else target.push(chunk); };
    child.stdout.on("data", (chunk) => {
      collect(stdout, chunk);
      if (!relay) return;
      remainder += chunk.toString("utf8");
      const lines = remainder.split("\n"); remainder = lines.pop() ?? "";
      for (const line of lines) { const match = /^TLS_PHASE ([a-z-]{1,60})$/.exec(line); if (match && !signal.aborted) phase(match[1]); }
    });
    child.stderr.on("data", (chunk) => collect(stderr, chunk));
    child.stdin.on("error", () => undefined);
    child.once("error", () => { clearTimeout(timer); signal.removeEventListener("abort", stop); reject(new Error("TLS_DOCKER_SPAWN")); });
    child.once("close", (code) => {
      clearTimeout(timer); signal.removeEventListener("abort", stop);
      if (failure) return reject(failure);
      if (code !== 0) {
        const text = Buffer.concat(stderr).toString("utf8");
        const error = new Error(`TLS_DOCKER_EXIT_${code}`);
        error.dockerCategory = /unhealthy/i.test(text) ? "unhealthy"
          : /no healthcheck/i.test(text) ? "no-healthcheck"
            : /didn.t complete successfully|exited.*code/i.test(text) ? "service-exit"
              : /seccomp/i.test(text) ? "seccomp" : /address already in use|port.*allocated/i.test(text) ? "port-binding" : "unclassified";
        return reject(error);
      }
      resolve(Buffer.concat(stdout).toString("utf8"));
    });
    child.stdin.end(input);
  });
  };
}

export async function runTlsAcceptance({ appImage = "rimo:local", workerImage = "rimo-export:local", deadlineMs = 360_000 } = {}) {
  assert.equal(process.env.RIMO_TEST_DOCKER_TLS, "1", "TLS_OPT_IN_REQUIRED");
  for (const reference of [appImage, workerImage]) assert.match(reference, /^[a-zA-Z0-9][a-zA-Z0-9._/:@-]{0,255}$/, "TLS_IMAGE_REFERENCE_INVALID");
  const root = path.join(repository, "temp", "tls-acceptance");
  const project = `rimo-tls-${randomBytes(8).toString("hex")}`;
  const environment = { ...process.env, DOCKER_CLI_HINTS: "false", TLS_PG_PASSWORD: randomBytes(32).toString("base64url"), TLS_AUTH_SECRET: randomBytes(48).toString("base64url"), TLS_PDF_TOKEN: randomBytes(48).toString("base64url") };
  for (const key of Object.keys(environment)) if (key.startsWith("COMPOSE_")) delete environment[key];
  const credentials = { email: `tls-${randomBytes(8).toString("hex")}@example.test`, password: randomBytes(24).toString("base64url"), name: "TLS owner" };
  const report = { kind: "local-https-wss-acceptance", publicTlsAcceptance: false, systemTrustModified: false, status: "running", phase: "initialization", project };
  const lifecycle = createTlsLifecycle(report, deadlineMs);
  const phase = (value) => { if (!lifecycle.signal.aborted) { report.phase = value; process.stdout.write(`${JSON.stringify({ event: "tls_progress", phase: value })}\n`); } };
  const docker = createDockerRunner(environment, lifecycle.signal, phase);
  const started = performance.now();
  assert.match(project, /^rimo-tls-[a-f0-9]{16}$/);
  let directory;
  let compose;
  let owns = false;
  try {
    await mkdir(root, { recursive: true });
    directory = await mkdtemp(path.join(root, "run-"));
    const args = ["compose", "--ansi", "never", "--project-name", project, "--project-directory", directory, "--env-file", path.join(directory, "empty.env"), "--file", path.join(directory, "compose.json")];
    compose = (command, options) => docker([...args, ...command], options);
    report.environment = await sourceEnvironment(lifecycle.signal);
    phase("validate-images-and-project");
    const expectedImage = (await docker(["image", "inspect", "--format", "{{.Id}}", "--", appImage])).trim();
    const expectedWorker = (await docker(["image", "inspect", "--format", "{{.Id}}", "--", workerImage])).trim();
    assert.match(expectedImage, /^sha256:[a-f0-9]{64}$/); assert.match(expectedWorker, /^sha256:[a-f0-9]{64}$/);
    report.appImage = expectedImage; report.workerImage = expectedWorker;
    report.environment.docker = await docker(["version", "--format", '{"client":{{json .Client.Version}},"server":{{json .Server.Version}}}']).then(JSON.parse, () => null);
    report.environment.compose = await docker(["compose", "version", "--short"]).then((value) => value.trim(), () => null);
    for (const kind of ["container", "network", "volume"]) {
      const existing = await docker([kind === "container" ? "ps" : kind, ...(kind === "container" ? ["--all"] : ["ls"]), "--filter", `label=com.docker.compose.project=${project}`, "--quiet"]);
      assert.equal(existing.trim(), "", "TLS_PROJECT_ALREADY_EXISTS");
    }
    owns = true;
    const httpPort = await port(); let httpsPort = await port();
    while (httpsPort === httpPort) httpsPort = await port();
    const origin = `https://rimo.test:${httpsPort}`;
    const httpOrigin = `http://rimo.test:${httpPort}`;
    report.targetOrigin = origin;
    const production = await readFile(path.join(repository, "docker-compose.yml"), "utf8");
    const postgres = production.match(/image:\s+(postgres:18-[^\s]+@sha256:[a-f0-9]{64})/)[1];
    const caddy = production.match(/image:\s+(caddy:2@sha256:[a-f0-9]{64})/)[1];
    const caddyfile = `{\n  skip_install_trust\n  auto_https disable_redirects\n}\nhttp://rimo.test:${httpPort} {\n  redir ${origin}{uri} 308\n}\nhttps://rimo.test:${httpsPort} {\n  tls internal\n  encode gzip\n  handle /collaboration* {\n    reverse_proxy collaboration:1234\n  }\n  handle {\n    reverse_proxy app:3000\n  }\n}\n`;
    await writeFile(path.join(directory, "Caddyfile"), caddyfile, { mode: 0o600 });
    await writeFile(path.join(directory, "empty.env"), "", { mode: 0o600 });
    await writeFile(path.join(directory, "seccomp.json"), await readFile(path.join(repository, "config", "chromium-seccomp.json")), { mode: 0o600 });
    const serviceEnvironment = { DATABASE_URL: "postgresql://rimo:${TLS_PG_PASSWORD}@db:5432/rimo", BETTER_AUTH_SECRET: "${TLS_AUTH_SECRET}", BETTER_AUTH_URL: origin, COLLABORATION_PUBLIC_URL: `wss://rimo.test:${httpsPort}/collaboration`, ASSET_STORAGE_PATH: "/app/data/assets" };
    const health = (url) => ({ test: ["CMD", "node", "-e", `fetch('${url}').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))`], interval: "2s", timeout: "3s", retries: 30, start_period: "5s" });
    const config = {
      services: {
        db: { image: postgres, environment: { POSTGRES_DB: "rimo", POSTGRES_USER: "rimo", POSTGRES_PASSWORD: "${TLS_PG_PASSWORD}" }, volumes: ["postgres-data:/var/lib/postgresql"], networks: ["backend"], healthcheck: { test: ["CMD", "pg_isready", "-h", "127.0.0.1", "-U", "rimo", "-d", "rimo"], interval: "2s", timeout: "3s", retries: 30 }, mem_limit: "512m", cpus: 0.5, restart: "no" },
        migrate: { image: expectedImage, command: ["node", "--import=tsx", "scripts/migrate.ts"], environment: serviceEnvironment, networks: ["backend"], depends_on: { db: { condition: "service_healthy" } }, mem_limit: "384m", cpus: 0.5, restart: "no" },
        app: { image: expectedImage, environment: { ...serviceEnvironment, PDF_WORKER_URL: "http://export-worker:3100", PDF_WORKER_TOKEN: "${TLS_PDF_TOKEN}" }, volumes: ["assets:/app/data/assets"], networks: ["backend", "exports"], depends_on: { migrate: { condition: "service_completed_successfully" } }, healthcheck: health("http://127.0.0.1:3000/api/health"), mem_limit: "768m", cpus: 0.5, restart: "no" },
        collaboration: { image: expectedImage, command: ["node", "--enable-source-maps", "dist/collaboration/index.mjs"], environment: { ...serviceEnvironment, COLLABORATION_HOST: "0.0.0.0", COLLABORATION_PORT: "1234" }, networks: ["backend"], depends_on: { migrate: { condition: "service_completed_successfully" } }, healthcheck: health("http://127.0.0.1:1234/healthz"), mem_limit: "512m", cpus: 0.5, restart: "no" },
        "export-worker": { image: expectedWorker, environment: { PDF_WORKER_HOST: "0.0.0.0", PDF_WORKER_PORT: "3100", PDF_WORKER_TOKEN: "${TLS_PDF_TOKEN}", PDF_CHROMIUM_SANDBOX: "true" }, networks: ["exports"], read_only: true, tmpfs: ["/tmp:size=201326592,mode=1777"], security_opt: ["no-new-privileges:true", `seccomp=${path.join(directory, "seccomp.json")}`], cap_drop: ["ALL"], mem_limit: "768m", cpus: 0.5, shm_size: "128m", pids_limit: 256, healthcheck: health("http://127.0.0.1:3100/healthz"), restart: "no" },
        caddy: { image: caddy, ports: [`127.0.0.1:${httpPort}:${httpPort}`, `127.0.0.1:${httpsPort}:${httpsPort}`], volumes: [`${path.join(directory, "Caddyfile")}:/etc/caddy/Caddyfile:ro`, "caddy-data:/data", "caddy-config:/config"], networks: { backend: {}, ingress: { aliases: ["rimo.test"] } }, depends_on: { app: { condition: "service_healthy" }, collaboration: { condition: "service_healthy" } }, mem_limit: "128m", cpus: 0.25, restart: "no" },
        browser: { image: expectedWorker, command: ["node", "-e", "setTimeout(()=>process.exit(124),240000)"], networks: ["ingress"], read_only: true,
          tmpfs: ["/tmp:size=201326592,mode=1777"], security_opt: ["no-new-privileges:true", `seccomp=${path.join(directory, "seccomp.json")}`], cap_drop: ["ALL"],
          mem_limit: "768m", cpus: 0.5, shm_size: "128m", pids_limit: 256, healthcheck: { disable: true }, restart: "no" },
      }, networks: { backend: { internal: true }, exports: { internal: true }, ingress: {} }, volumes: { "postgres-data": {}, assets: {}, "caddy-data": {}, "caddy-config": {} },
    };
    await writeFile(path.join(directory, "compose.json"), JSON.stringify(config, null, 2), { mode: 0o600 });
    await compose(["config", "--quiet"]);
    phase("start-isolated-tls-stack");
    await compose(["up", "--detach", "--no-build", "--pull", "never", "--wait", "--wait-timeout", "120", "db", "migrate", "app", "collaboration", "export-worker", "caddy"], { timeout: 150_000 });
    await compose(["up", "--detach", "--no-build", "--pull", "never", "--no-deps", "browser"]);
    const ids = (await compose(["ps", "--all", "--quiet"])).trim().split(/\s+/);
    assert.equal(ids.length, 7, "TLS_CONTAINER_COUNT");
    for (const id of ids) {
      assert.match(id, /^[a-f0-9]{64}$/);
      const format = '{{json (index .Config.Labels "com.docker.compose.project")}}|{{json (index .Config.Labels "com.docker.compose.service")}}|{{json .NetworkSettings.Ports}}|{{json .Mounts}}';
      const [label, service, ports, mounts] = (await docker(["inspect", "--format", format, id])).trim().split("|");
      assert.equal(JSON.parse(label), project, "TLS_CONTAINER_OWNERSHIP");
      for (const bindings of Object.values(JSON.parse(ports) ?? {})) for (const binding of bindings ?? []) {
        assert.equal(JSON.parse(service), "caddy", "TLS_NON_CADDY_HOST_PORT"); assert.equal(binding.HostIp, "127.0.0.1", "TLS_HOST_BINDING");
        assert.ok([httpPort, httpsPort].includes(Number(binding.HostPort)), "TLS_HOST_PORT");
      }
      for (const mount of JSON.parse(mounts)) {
        if (mount.Type === "bind") { assert.equal(JSON.parse(service), "caddy"); assert.equal(mount.RW, false); assert.equal(mount.Destination, "/etc/caddy/Caddyfile"); }
        else if (mount.Type === "volume") assert.ok(mount.Name.startsWith(project + "_"), "TLS_VOLUME_OWNERSHIP");
      }
    }
    report.loopbackOnlyPorts = true;
    phase("verify-local-caddy-tls");
    const ca = await compose(["exec", "-T", "caddy", "cat", "/data/caddy/pki/authorities/local/root.crt"]);
    const verifiedRequest = (pathname) => new Promise((resolve, reject) => {
      const request = httpsRequest({ hostname: "127.0.0.1", port: httpsPort, servername: "rimo.test", path: pathname, ca,
        headers: { Host: `rimo.test:${httpsPort}` }, rejectUnauthorized: true, signal: lifecycle.signal, timeout: 10_000 }, (response) => {
        response.resume();
        resolve({ status: response.statusCode, certificateAuthorized: response.socket.authorized, serverIsCaddy: /caddy/i.test(String(response.headers.server)) });
      });
      request.once("error", () => reject(new Error("LOCAL_CA_PROBE_FAILED")));
      request.once("timeout", () => request.destroy(new Error("LOCAL_CA_PROBE_TIMEOUT")));
      request.end();
    });
    report.verifiedCaProbe = await verifiedRequest("/api/health");
    assert.equal(report.verifiedCaProbe.status, 200, "LOCAL_CA_HEALTH_STATUS");
    assert.equal(report.verifiedCaProbe.certificateAuthorized, true, "LOCAL_CA_CERTIFICATE");
    report.verifiedRootHttp1 = await verifiedRequest("/");
    report.verifiedRootHttp2 = await new Promise((resolve, reject) => {
      const session = connectHttp2(origin, { createConnection: () => connectTls({ host: "127.0.0.1", port: httpsPort, servername: "rimo.test", ca, rejectUnauthorized: true, ALPNProtocols: ["h2"] }) });
      const timer = setTimeout(() => { session.destroy(); reject(new Error("LOCAL_HTTP2_TIMEOUT")); }, 10_000);
      const cancelled = () => { clearTimeout(timer); session.destroy(); reject(lifecycle.signal.reason); };
      lifecycle.signal.addEventListener("abort", cancelled, { once: true });
      const failed = (error) => {
        if (/^[A-Z][A-Z0-9_]{1,70}$/.test(error?.code ?? "")) report.http2ErrorCode ??= error.code;
        clearTimeout(timer); lifecycle.signal.removeEventListener("abort", cancelled); session.destroy(); reject(new Error("LOCAL_HTTP2_FAILED"));
      };
      session.once("error", failed);
      const request = session.request({ ":method": "GET", ":path": "/", ":authority": `rimo.test:${httpsPort}` });
      let result;
      request.once("response", (headers) => { result = { status: headers[":status"], certificateAuthorized: session.socket.authorized, protocol: "h2" }; });
      request.on("data", () => undefined);
      request.once("error", failed);
      request.once("end", () => { clearTimeout(timer); lifecycle.signal.removeEventListener("abort", cancelled); session.close(); resolve(result); });
      request.end();
    });
    assert.equal(report.verifiedRootHttp1.status, 200, "LOCAL_ROOT_HTTP1_STATUS");
    assert.equal(report.verifiedRootHttp2.status, 200, "LOCAL_ROOT_HTTP2_STATUS");
    phase("provision-owner-via-stdin");
    const provision = "(async()=>{const chunks=[];for await(const c of process.stdin)chunks.push(c);const value=JSON.parse(Buffer.concat(chunks).toString('utf8'));process.env.OWNER_EMAIL=value.email;process.env.OWNER_PASSWORD=value.password;process.env.OWNER_NAME=value.name;await import('./scripts/create-owner.ts');})().catch(()=>{process.exitCode=1;});";
    await compose(["exec", "-T", "app", "node", "--import=tsx", "-e", provision], { input: Buffer.from(JSON.stringify(credentials)) });
    report.ownerProvisioned = true;
    phase("linux-browser-acceptance");
    const caddyId = (await compose(["ps", "--quiet", "caddy"])).trim();
    assert.match(caddyId, /^[a-f0-9]{64}$/);
    const resolverAddress = (await docker(["inspect", "--format", `{{(index .NetworkSettings.Networks "${project}_ingress").IPAddress}}`, caddyId])).trim();
    assert.match(resolverAddress, /^\d{1,3}(\.\d{1,3}){3}$/);
    const runner = String.raw`
      import { checkTlsBrowser } from './browser.mjs';
      const parts=[];
      for await(const part of process.stdin)parts.push(part);
      const fixture=JSON.parse(Buffer.concat(parts).toString('utf8'));
      const controller=new AbortController();
      const timer=setTimeout(()=>controller.abort(),150000);
      const evidence={};
      const result={status:'failed',evidence};
      const phase=value=>process.stdout.write('TLS_PHASE '+value+'\n');
      try{
        await checkTlsBrowser({...fixture,signal:controller.signal,phase,evidence});
        controller.signal.throwIfAborted();
        result.status='passed';
      }catch(error){
        result.errorKind=['Error','TimeoutError','AssertionError','TypeError'].includes(error.name)?error.name:'unknown';
        const message=String(error.message).split('\n')[0];
        result.errorCode=/^[A-Z][A-Z0-9_]{1,79}$/.test(message)?message:message.match(/\bERR_[A-Z_]+\b/)?.[0]??'CHECK_FAILED';
      }finally{clearTimeout(timer);}
      process.stdout.write('TLS_RESULT '+JSON.stringify(result)+'\n');
    `;
    const install = String.raw`(async()=>{const fs=require('node:fs/promises');const parts=[];for await(const part of process.stdin)parts.push(part);const files=JSON.parse(Buffer.concat(parts).toString('utf8'));const root='/tmp/tls-acceptance';await fs.mkdir(root);await fs.symlink('/app/node_modules',root+'/node_modules','dir');for(const name of ['browser.mjs','run.mjs'])await fs.writeFile(root+'/'+name,files[name],{flag:'wx',mode:0o600});})().catch(()=>{process.exitCode=1;});`;
    await compose(["exec", "-T", "browser", "node", "-e", install], { input: Buffer.from(JSON.stringify({ "browser.mjs": await readFile(new URL("./browser.mjs", import.meta.url), "utf8"), "run.mjs": runner })) });
    const resultText = await compose(["exec", "-T", "browser", "node", "/tmp/tls-acceptance/run.mjs"], { input: Buffer.from(JSON.stringify({ origin, httpOrigin, credentials, resolverAddress })), timeout: 180_000, relay: true });
    const resultLine = resultText.trim().split(/\r?\n/).findLast((line) => line.startsWith("TLS_RESULT "));
    assert.ok(resultLine, "BROWSER_SAFE_RESULT_MISSING");
    const result = JSON.parse(resultLine.slice("TLS_RESULT ".length));
    report.browser = result.evidence;
    report.browserRuntime = "isolated-linux-container";
    if (result.status !== "passed") { report.browserErrorKind = result.errorKind; throw new Error(result.errorCode ?? "BROWSER_ACCEPTANCE_FAILED"); }
    lifecycle.signal.throwIfAborted();
    report.status = "passed";
  } catch (error) {
    report.status = "failed";
    if (error.dockerCategory) report.dockerErrorCategory = error.dockerCategory;
    if (owns) {
      const text = await compose(["ps", "--all", "--format", "json"], { cleanup: true }).catch(() => "[]");
      try {
        const rows = text.trim().startsWith("[") ? JSON.parse(text) : text.trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
        report.serviceStates = rows.map(({ Service, State, Health, ExitCode }) => ({ service: Service, state: State, health: Health, exitCode: ExitCode }));
      } catch { report.serviceStates = "unavailable"; }
    }
    report.errorKind = ["Error", "TimeoutError", "AssertionError", "TypeError"].includes(error.name) ? error.name : "unknown";
    const message = String(error.message).split("\n")[0];
    report.errorCode = /^[A-Z][A-Z0-9_]{1,79}$/.test(message) ? message : message.match(/\bERR_[A-Z_]+\b/)?.[0] ?? "CHECK_FAILED";
  } finally {
    if (owns) {
      try {
        assert.match(project, /^rimo-tls-[a-f0-9]{16}$/);
        const volumes = (await docker(["volume", "ls", "--filter", `label=com.docker.compose.project=${project}`, "--format", "{{.Name}}"], { cleanup: true })).trim().split(/\s+/).filter(Boolean);
        assert.ok(volumes.every((name) => name.startsWith(project + "_")), "TLS_CLEANUP_VOLUME_OWNERSHIP");
        await compose(["down", "--volumes", "--timeout", "5"], { cleanup: true });
        for (const kind of ["container", "network", "volume"]) {
          const remaining = await docker([kind === "container" ? "ps" : kind, ...(kind === "container" ? ["--all"] : ["ls"]), "--filter", `label=com.docker.compose.project=${project}`, "--quiet"], { cleanup: true, timeout: 10_000 });
          assert.equal(remaining.trim(), "", "TLS_CLEANUP_RESOURCE_REMAINS");
        }
        report.cleanup = "removed-own-project-and-volumes";
        report.cleanupVerified = true;
      } catch { report.cleanup = "failed"; report.status = "failed"; }
    }
    try {
      if (directory && report.cleanup !== "failed") {
        try {
          const target = path.resolve(directory);
          assert.equal(path.dirname(target), root, "TLS_TEMP_PARENT");
          assert.ok(path.basename(target).startsWith("run-"), "TLS_TEMP_PREFIX");
          await rm(target, { recursive: true, force: true });
          report.runDirectoryRemoved = true;
        } catch { report.cleanup = "failed"; report.status = "cleanup-failed"; }
      }
      report.elapsedMs = Math.round(performance.now() - started);
      const output = path.join(root, `result-${Date.now()}-${project.slice(-16)}.json`);
      report.output = path.relative(repository, output).split(path.sep).join("/");
      try {
        await lifecycle.finalize(() => writeFile(output, JSON.stringify(report, null, 2) + "\n", { mode: 0o600 }));
      } catch { report.status = "failed"; report.reportWrite = "failed"; }
      lifecycle.apply();
      process.stdout.write(`${JSON.stringify(report)}\n`);
      process.exitCode = lifecycle.exitCode();
    } finally { lifecycle.dispose(); }
  }
  return report;
}

async function cli() {
  let values;
  try { ({ values } = parseArgs({ options: { help: { type: "boolean" }, "app-image": { type: "string", default: "rimo:local" }, "worker-image": { type: "string", default: "rimo-export:local" }, "deadline-ms": { type: "string", default: "360000" } } })); }
  catch { throw new Error("TLS_OPTIONS_INVALID"); }
  if (values.help) { process.stdout.write("RIMO_TEST_DOCKER_TLS=1 node scripts/tls-acceptance/run.mjs [--app-image rimo:local] [--worker-image rimo-export:local] [--deadline-ms 360000]\n"); return; }
  await runTlsAcceptance({ appImage: values["app-image"], workerImage: values["worker-image"], deadlineMs: Number(values["deadline-ms"]) });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await cli().catch((error) => {
    const message = String(error.message).split("\n")[0];
    process.stderr.write(`${JSON.stringify({ status: "failed", errorCode: /^[A-Z][A-Z0-9_]{1,79}$/.test(message) ? message : "TLS_SETUP_FAILED" })}\n`);
    process.exitCode = 1;
  });
}
