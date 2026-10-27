import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execute = promisify(execFile);
const docker = async (args) => (await execute("docker", args, { windowsHide: true, timeout: 30_000, maxBuffer: 1_048_576 })).stdout.trim();
const directory = fileURLToPath(new URL(".", import.meta.url));
const artifactDirectory = path.resolve(directory, "../../../temp/performance");
export const NETWORK_CALIBRATION_FILE = path.join(artifactDirectory, "network-calibration.json");
export const NETWORK_GUEST_STATE_FILE = path.join(artifactDirectory, "network-guest-storage.json");
export const NETWORK_SELF_TEST_FILE = path.join(artifactDirectory, "network-self-test.json");
const IMAGE = "rimo-network-probe:local";

async function fingerprint(files) {
  const hash = createHash("sha256");
  for (const filename of files.toSorted()) { hash.update(filename); hash.update(await readFile(path.join(directory, filename))); }
  return hash.digest("hex");
}

export async function networkSourceHash() {
  const local = (await readdir(directory)).filter((name) => name.endsWith(".mjs") || ["Dockerfile", "tinyproxy.conf", ".dockerignore"].includes(name));
  return fingerprint([...local, "../common.mjs", "../cookies.mjs", "../fixture.mjs", "../service-target.mjs"]);
}

export async function cleanupStep(report, step, operation) {
  try { await operation(); report.cleanup.push({ step, status: "complete" }); return true; }
  catch (error) { report.cleanup.push({ step, status: "failed", errorType: error instanceof Error ? error.name : "UnknownError" }); return false; }
}

export async function writeNetworkReport(filename, report) {
  await mkdir(path.dirname(filename), { recursive: true });
  const staging = `${filename}.pending-${randomUUID()}`;
  try {
    await writeFile(staging, `${JSON.stringify(report, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    await rename(staging, filename);
  } finally { await rm(staging, { force: true }); }
}

async function freePort() {
  const server = createServer();
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

export async function startHelper(onCreating) {
  await mkdir(artifactDirectory, { recursive: true });
  const ports = { api: await freePort(), proxy: await freePort() };
  const runId = randomUUID();
  const label = `rimo.network-probe=${runId}`;
  const cidfile = path.join(artifactDirectory, `network-cid-${runId}`);
  const descriptor = { runId, label };
  let identifier;
  let closed = false;
  const close = async () => {
    if (closed) return;
    const owned = async () => (await docker(["ps", "--all", "--quiet", "--no-trunc", "--filter", `label=${label}`])).split(/\r?\n/).filter(Boolean);
    let ids = await owned();
    if (!ids.length) { closed = true; await rm(cidfile, { force: true }); return; }
    assert.equal(ids.length, 1, "Refusing to stop multiple containers with the same probe label");
    const [id] = ids;
    assert.match(id, /^[a-f0-9]{64}$/);
    if (identifier) assert.equal(id, identifier, "Refusing to stop a different probe container");
    try {
      const actualLabel = await docker(["inspect", "--format", '{{index .Config.Labels "rimo.network-probe"}}', id]);
      assert.equal(actualLabel, runId, "Refusing to stop an unrelated container");
      await docker(["rm", "--force", id]);
    } catch (error) { ids = await owned(); if (ids.length) throw error; }
    closed = true;
    await rm(cidfile, { force: true });
  };
  try {
    await onCreating?.(descriptor);
    const image = await docker(["image", "inspect", "--format", "{{.Id}}", IMAGE]);
    identifier = await docker(["run", "--detach", "--rm", "--pull", "never", "--cidfile", cidfile, "--name", `rimo-network-${runId}`, "--label", label,
      "--cap-drop", "ALL", "--cap-add", "NET_ADMIN", "--security-opt", "no-new-privileges", "--memory", "192m", "--pids-limit", "128",
      "--publish", `127.0.0.1:${ports.api}:8474`, "--publish", `127.0.0.1:${ports.proxy}:8666`, image]);
    assert.match(identifier, /^[a-f0-9]{64}$/);
    const origin = `http://127.0.0.1:${ports.api}`;
    const api = async (resource, method = "GET", value) => {
      const response = await fetch(`${origin}${resource}`, { method, ...(value === undefined ? {} : {
        headers: { "Content-Type": "application/json" }, body: JSON.stringify(value),
      }), signal: AbortSignal.timeout(5_000) });
      assert.ok(response.ok, `Network helper API returned ${response.status}`);
      return response.status === 204 ? undefined : response.json();
    };
    let ready = false;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (await fetch(`${origin}/version`, { signal: AbortSignal.timeout(250) }).then((response) => response.ok, () => false)) { ready = true; break; }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.ok(ready, "Network helper did not become ready");
    const metadata = { id: identifier, runId, image: await docker(["inspect", "--format", "{{.Image}}", identifier]),
      helperConfigurationSha256: await fingerprint(["Dockerfile", "boot.mjs", "tinyproxy.conf", "helper.mjs", ".dockerignore"]),
      toxiproxy: await api("/version"), iproute2: await docker(["exec", identifier, "tc", "-V"]),
      tinyproxy: await docker(["exec", identifier, "tinyproxy", "-v"]), perDirectionBitsPerSecond: 50_000_000,
      capabilityScope: "NET_ADMIN only in this container's private network namespace", hostNetworking: false };
    return {
      metadata, proxy: { server: `http://127.0.0.1:${ports.proxy}`, bypass: "<-loopback>" }, close,
      async configure(localPorts, latencyMs) {
        const existing = await api("/proxies");
        for (const name of Object.keys(existing)) await api(`/proxies/${name}`, "DELETE");
        for (const port of localPorts) {
          assert.ok([3080, 18991].includes(port), "Only the isolated echo or Rimo test port is allowed");
          await api("/proxies", "POST", { name: `loopback-${port}`, listen: `[::]:${port}`, upstream: `host.docker.internal:${port}`, enabled: true });
        }
        await api("/proxies", "POST", { name: "browser", listen: "0.0.0.0:8666", upstream: "127.0.0.1:8888", enabled: true });
        if (latencyMs) for (const stream of ["upstream", "downstream"]) {
          await api("/proxies/browser/toxics", "POST", { name: `latency-${stream}`, type: "latency", stream, toxicity: 1,
            attributes: { latency: latencyMs, jitter: 0 } });
        }
      },
      async statistics() { return { format: "tc -s class show", output: await docker(["exec", identifier, "tc", "-s", "class", "show", "dev", "eth0"]) }; },
    };
  } catch (error) {
    if (!identifier) identifier = await readFile(cidfile, "utf8").then((value) => value.trim(), () => undefined);
    try { await close(); }
    catch { const failure = new Error("Network helper setup cleanup requires attention"); failure.networkHelper = descriptor; throw failure; }
    throw error;
  }
}
