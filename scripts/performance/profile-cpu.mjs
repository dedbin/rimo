import { spawn, execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs, promisify } from "node:util";

import { summarizeCpuProfile } from "./cpu-profile-summary.mjs";

const execute = promisify(execFile);
const { values } = parseArgs({ options: {
  "compose-project": { type: "string", default: "rimo-rework" },
  seconds: { type: "string", default: "60" },
  output: { type: "string", default: "temp/performance/collaboration.cpuprofile" },
  "start-signal": { type: "string" },
} });

async function main() {
  if (!/^[a-z0-9][a-z0-9_-]{0,62}$/.test(values["compose-project"])) throw new Error("Invalid project");
  const seconds = Number(values.seconds);
  if (!Number.isSafeInteger(seconds) || seconds < 1 || seconds > 300) throw new Error("Invalid duration");
  const output = path.resolve(values.output);
  const temp = path.resolve("temp") + path.sep;
  if (!output.startsWith(temp) || !output.endsWith(".cpuprofile")) throw new Error("CPU profiles must stay in ignored temp");
  const signal = values["start-signal"] ? path.resolve(values["start-signal"]) : null;
  if (signal && (!signal.startsWith(path.resolve("temp/performance") + path.sep) || existsSync(signal))) throw new Error("Invalid start signal");
  const { stdout } = await execute("docker", ["ps", "--filter", `label=com.docker.compose.project=${values["compose-project"]}`,
    "--filter", "label=com.docker.compose.service=collaboration", "--format", "{{.ID}}"], { windowsHide: true, timeout: 10_000 });
  const ids = stdout.trim().split(/\r?\n/);
  if (ids.length !== 1 || !/^[a-f0-9]{12,64}$/.test(ids[0])) throw new Error("Expected exactly one collaboration container");
  let sourceMap;
  try {
    // Read the exact selected runtime's map before profiling, never a potentially stale host build.
    const mapped = await execute("docker", ["exec", ids[0], "node", "--input-type=module", "-e",
      'import{readFileSync,statSync}from"node:fs";const p="/app/dist/collaboration/index.mjs.map";const s=statSync(p);if(!s.isFile()||s.size<1||s.size>1048576)process.exit(2);process.stdout.write(readFileSync(p));'],
    { windowsHide: true, timeout: 5_000, killSignal: "SIGKILL", maxBuffer: 1_048_576 });
    sourceMap = mapped.stdout;
  } catch { /* Raw profiling remains useful; the summary must expose unavailable source attribution. */ }
  const script = await readFile(new URL("./cpu-profile-target.mjs", import.meta.url), "utf8");
  const child = spawn("docker", ["exec", "-i", ids[0], "node", "--input-type=module", "-e", script, String(seconds)],
    { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  let result;
  let buffered = "";
  let overflow = false;
  let interrupted = false;
  let startError = false;
  let releasing = Promise.resolve();
  const abort = () => { interrupted = true; if (!child.stdin.destroyed) child.stdin.write("abort\n"); };
  process.on("SIGINT", abort); process.on("SIGTERM", abort);
  const watchdog = setTimeout(abort, (seconds + 20) * 1_000);
  child.stderr.on("data", () => undefined); // Never print arbitrary child diagnostics.
  child.stdout.on("data", (chunk) => {
    if (overflow) return;
    buffered += chunk.toString("utf8");
    if (buffered.length > 32 * 1024 * 1024) { overflow = true; abort(); return; }
    let newline;
    while ((newline = buffered.indexOf("\n")) !== -1) {
      const line = buffered.slice(0, newline); buffered = buffered.slice(newline + 1);
      let message;
      try { message = JSON.parse(line); } catch { overflow = true; abort(); return; }
      if (message.event === "cpu_profile_started") {
        process.stdout.write(`${JSON.stringify(message)}\n`);
        if (signal) releasing = writeFile(signal, "start\n", { flag: "wx", mode: 0o600 }).catch(() => { startError = true; abort(); });
      }
      else result = message;
    }
  });
  let code;
  try {
    code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
  } finally {
    clearTimeout(watchdog); process.off("SIGINT", abort); process.off("SIGTERM", abort); child.stdin.end();
    await releasing;
    if (signal) await rm(signal, { force: true });
  }
  const summary = result?.profile ? summarizeCpuProfile(result.profile, { sourceMap }) : null;
  let portClosed = false;
  try {
    await execute("docker", ["exec", ids[0], "node", "-e",
      'fetch("http://127.0.0.1:9229/json/list",{signal:AbortSignal.timeout(1000)}).then(()=>process.exit(1)).catch(e=>process.exit(e.cause?.code==="ECONNREFUSED"?0:2))'],
    { windowsHide: true, timeout: 5_000 });
    portClosed = true;
  } catch { /* The controlled report must make an unclosed inspector visible. */ }
  await mkdir(path.dirname(output), { recursive: true });
  if (result?.profile) await writeFile(output, JSON.stringify(result.profile), { mode: 0o600 });
  const report = { kind: "collaboration-cpu-diagnostic", composeProject: values["compose-project"],
    requestedSeconds: seconds, startedAt: result?.startedAt, interrupted: interrupted || result?.interrupted,
    sourceMapRead: sourceMap === undefined ? "unavailable" : "selected-container", sourceMapContainer: ids[0],
    inspectorClosed: result?.inspectorClosed === true && portClosed, independentPortCheck: portClosed, errorPhase: result?.phase, summary };
  await writeFile(output + ".summary.json", JSON.stringify(report, null, 2), { mode: 0o600 });
  process.stdout.write(`${JSON.stringify({ event: "cpu_profile_finished", output,
    inspectorClosed: report.inspectorClosed, sampledMs: summary?.sampledMs })}\n`);
  if (code !== 0 || overflow || startError || report.interrupted || !result?.profile || !report.inspectorClosed) process.exitCode = 1;
}

await main().catch(() => { process.stderr.write("CPU profiling failed; inspect the controlled summary\n"); process.exitCode = 1; });
