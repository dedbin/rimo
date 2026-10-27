import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { fail } from "./common.mjs";

/** Bind the observed worker to the project serving the measured browser origin. */
export function validateProjectBindings(containers, project) {
  if (!Array.isArray(containers) || containers.some((entry) => entry.project !== project)) throw new Error("Container project labels do not match the selected project");
  const caddies = containers.filter((entry) => entry.service === "caddy");
  const workers = containers.filter((entry) => entry.service === "export-worker");
  if (caddies.length !== 1 || workers.length !== 1) throw new Error("Selected project must have exactly one Caddy and one worker");
  const [caddy] = caddies; const [worker] = workers;
  if ([caddy, worker].some((entry) => !/^[a-f0-9]{64}$/.test(entry.id) || !/^sha256:[a-f0-9]{64}$/.test(entry.imageId))) throw new Error("Container identity metadata is invalid");
  const compatible = new Set(["127.0.0.1", "0.0.0.0", "::1", "::"]);
  const bindings = Object.entries(caddy.ports ?? {}).flatMap(([port, values]) => !port.endsWith("/tcp") || !Array.isArray(values) ? [] :
    values.filter((value) => value && String(value.HostPort) === "3080" && compatible.has(value.HostIp))
      .map((value) => ({ containerPort: port, hostIp: value.HostIp, hostPort: "3080" })));
  if (!bindings.length) throw new Error("Selected project Caddy does not publish TCP 3080 on a localhost-compatible bind");
  return { project, caddy: { ...caddy, browserBindings: bindings }, worker: { ...worker } };
}

export async function inspectProject(project) {
  assert.match(project, /^[a-z0-9][a-z0-9_-]{0,62}$/);
  const { stdout } = await promisify(execFile)("docker", ["ps", "--quiet", "--no-trunc", "--filter", `label=com.docker.compose.project=${project}`],
    { windowsHide: true, timeout: 10_000, maxBuffer: 16_384 });
  const ids = stdout.trim().split(/\r?\n/).filter(Boolean);
  if (!ids.length || ids.length > 64 || ids.some((id) => !/^[a-f0-9]{64}$/.test(id))) throw fail("Unexpected selected-project container inventory");
  const format = '{"project":{{json (index .Config.Labels "com.docker.compose.project")}},"service":{{json (index .Config.Labels "com.docker.compose.service")}},"imageId":{{json .Image}},"ports":{{json .NetworkSettings.Ports}}}';
  const inspected = await promisify(execFile)("docker", ["inspect", "--format", format, ...ids], { windowsHide: true, timeout: 10_000, maxBuffer: 131_072 });
  const lines = inspected.stdout.trim().split(/\r?\n/).filter(Boolean);
  if (lines.length !== ids.length) throw fail("Selected-project metadata inventory changed during preflight");
  try { return validateProjectBindings(lines.map((line, index) => ({ ...JSON.parse(line), id: ids[index] })), project); }
  catch { throw fail("Selected project must own localhost TCP 3080 through one Caddy and have one worker"); }
}
