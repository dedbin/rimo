import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import path from "node:path";

/** Reserve one private directory; an existing path is never adopted or cleared. */
export async function reservePdfDirectory(output) {
  const directory = path.join(path.dirname(path.resolve(output)), `pdf-${randomUUID()}`);
  await mkdir(directory, { mode: 0o700 });
  return directory;
}

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
