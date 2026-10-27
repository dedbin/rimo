import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execute = promisify(execFile);
const FIELDS = ["rssBytes", "heapUsedBytes", "heapTotalBytes", "externalBytes", "arrayBuffersBytes", "heapLimitBytes",
  "eventLoopSamples", "gcCount", "gcTotalMs", "gcMaxMs", "majorGcCount", "majorGcTotalMs", "majorGcMaxMs"];
const DELAYS = ["eventLoopP95Ms", "eventLoopMaxMs"];
const INTEGERS = FIELDS.filter((key) => !key.endsWith("Ms"));

/** @param {unknown} value */
export function validatedRuntimeMetrics(value) {
  if (!value || typeof value !== "object") throw new Error("Runtime metrics are unavailable");
  const source = /** @type {Record<string, unknown>} */ (value);
  if (source.version !== 1) throw new Error("Unknown runtime metrics version");
  const result = { version: 1 };
  for (const key of FIELDS) {
    if (typeof source[key] !== "number" || !Number.isFinite(source[key]) || source[key] < 0 ||
        INTEGERS.includes(key) && !Number.isSafeInteger(source[key])) throw new Error("Invalid runtime counter");
    result[key] = source[key];
  }
  for (const key of DELAYS) {
    if (source.eventLoopSamples === 0) {
      if (source[key] !== null) throw new Error("Missing event-loop observation must remain null");
      result[key] = null;
    } else if (typeof source[key] === "number" && Number.isFinite(source[key]) && source[key] >= 0) result[key] = source[key];
    else throw new Error("Invalid event-loop observation");
  }
  if (result.rssBytes <= 0 || result.heapLimitBytes <= 0 || result.heapUsedBytes > result.heapTotalBytes ||
      result.majorGcCount > result.gcCount || result.majorGcTotalMs > result.gcTotalMs || result.majorGcMaxMs > result.gcMaxMs ||
      result.gcMaxMs > result.gcTotalMs || result.majorGcMaxMs > result.majorGcTotalMs ||
      result.eventLoopP95Ms !== null && result.eventLoopP95Ms > result.eventLoopMaxMs) throw new Error("Inconsistent runtime counters");
  return result;
}

// The observer process runs in app, avoiding extra V8 heap pressure in collaboration.
const PROBE = String.raw`
  (async()=>{
    const response=await fetch('http://collaboration:1234/healthz',{signal:AbortSignal.timeout(5000)});
    let text='';
    for await(const bytes of response.body){text+=Buffer.from(bytes).toString('utf8');if(text.length>16384)throw new Error('Response bound');}
    const value=JSON.parse(text);
    process.stdout.write(JSON.stringify({httpStatus:response.status,status:value.status,runtime:value.runtime}));
  })().catch(()=>{process.exitCode=1;});
`;

/**
 * Only a selected project's single running app may read its private backend health.
 * @param {string | undefined} project
 * @param {(program: string, args: string[], options: {timeout: number, maxBuffer: number, windowsHide: boolean}) => Promise<{stdout: string, stderr?: string}>} [run]
 */
export async function sampleCollaborationRuntime(project, run = execute) {
  if (!project) return { available: false, reason: "compose-project-not-selected" };
  try {
    if (!/^[a-z0-9][a-z0-9_-]{0,62}$/.test(project)) throw new Error("Invalid project");
    const deadline = performance.now() + 10_000;
    const invoke = async (args, maxBuffer = 16_384) => {
      const remaining = Math.floor(deadline - performance.now());
      if (remaining <= 0) throw new Error("Runtime sample deadline");
      return run("docker", args, { timeout: remaining, maxBuffer, windowsHide: true });
    };
    const listed = await invoke(["ps", "--quiet", "--no-trunc", "--filter", `label=com.docker.compose.project=${project}`,
      "--filter", "label=com.docker.compose.service=app"]);
    const ids = listed.stdout.trim().split(/\r?\n/).filter(Boolean);
    if (ids.length !== 1 || !/^[a-f0-9]{64}$/.test(ids[0])) throw new Error("Ambiguous app container");
    const format = '{"project":{{json (index .Config.Labels "com.docker.compose.project")}},"service":{{json (index .Config.Labels "com.docker.compose.service")}}}';
    const identity = JSON.parse((await invoke(["inspect", "--format", format, ids[0]])).stdout);
    if (identity.project !== project || identity.service !== "app") throw new Error("Container identity changed");
    const sampled = JSON.parse((await invoke(["exec", ids[0], "node", "-e", PROBE], 32_768)).stdout);
    if (![200, 503].includes(sampled.httpStatus) || !["ok", "unavailable"].includes(sampled.status)) throw new Error("Invalid health response");
    return { available: true, httpStatus: sampled.httpStatus, healthy: sampled.httpStatus === 200 && sampled.status === "ok",
      metrics: validatedRuntimeMetrics(sampled.runtime) };
  } catch { return { available: false, reason: "runtime-sample-unavailable" }; }
}
