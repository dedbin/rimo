import assert from "node:assert/strict";
import { execFile, fork } from "node:child_process";
import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { NETWORK_CALIBRATION_FILE, NETWORK_SELF_TEST_FILE, networkSourceHash, writeNetworkReport } from "./helper.mjs";

const execute = promisify(execFile);
const directory = fileURLToPath(new URL(".", import.meta.url));
const result = { kind: "network-interruption-regression", status: "running", at: new Date().toISOString(), networkSourceSha256: await networkSourceHash(), cases: [] };
const docker = async (args) => (await execute("docker", args, { timeout: 10_000, windowsHide: true })).stdout.trim();

async function remaining(report) {
  const ids = [];
  for (const { runId } of report.helperAttempts ?? []) {
    assert.match(runId, /^[a-f0-9-]{36}$/);
    const found = await docker(["ps", "--all", "--quiet", "--no-trunc", "--filter", `label=rimo.network-probe=${runId}`]);
    if (found) ids.push(...found.split(/\r?\n/));
  }
  return ids;
}

async function run(script, reportFile, reason) {
  await rm(reportFile, { force: true });
  const child = fork(path.join(directory, script), [], { windowsHide: true, stdio: ["ignore", "pipe", "pipe", "ipc"],
    execArgv: ["--import=tsx", `--import=${pathToFileURL(path.join(directory, "signal-preload.mjs")).href}`],
    env: { ...process.env, RIMO_NETWORK_DEADLINE_MS: reason === "deadline" ? "4000" : "60000" } });
  const started = performance.now();
  let requested = reason === "deadline";
  let output = "";
  let timedOut = false;
  if (requested) child.disconnect();
  child.stdout.on("data", (data) => {
    output += data.toString();
    const phase = script === "calibrate.mjs" ? "download-1" : "browser-0-ready";
    if (!requested && output.includes(phase)) {
      requested = true;
      if (process.platform === "win32") child.send({ type: "network-test-signal", signal: reason }, () => child.disconnect());
      else { child.kill(reason); child.disconnect(); }
    }
    if (output.length > 65_536) output = output.slice(-32_768);
  });
  // Inert fixtures contain no credentials; do not retain arbitrary child logs.
  child.stderr.resume();
  const timeout = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, 25_000);
  let ended;
  try { ended = await new Promise((resolve, reject) => { child.once("error", reject); child.once("exit", (code, signal) => resolve({ code, signal })); }); }
  finally { clearTimeout(timeout); }
  const report = JSON.parse(await readFile(reportFile, "utf8"));
  const leftovers = await remaining(report);
  if (leftovers.length) {
    // Only exact UUID labels captured from this child's persisted attempts.
    for (const id of leftovers) await docker(["rm", "--force", id]);
  }
  assert.equal(timedOut, false, "Interrupted fixture exceeded its bounded cleanup time");
  assert.equal(requested, true, "The fixture never reached an active browser/helper phase");
  assert.ok(report.helperAttempts.length > 0, "The test did not create a real detached helper");
  assert.equal(report.status, "interrupted", "The signal must reach normal cleanup and the final interrupted report");
  assert.equal(report.interruption.reason, reason);
  assert.equal(ended.code, reason === "SIGINT" ? 130 : reason === "SIGTERM" ? 143 : 124);
  assert.ok(report.cleanup.length >= 3 && report.cleanup.every((step) => step.status === "complete"));
  assert.equal(leftovers.length, 0, "The fixture left a detached helper alive");
  result.cases.push({ script, reason, code: ended.code, status: report.status, helpers: report.helperAttempts.length,
    cleanupSteps: report.cleanup.length, milliseconds: performance.now() - started,
    delivery: reason === "deadline" ? "real watchdog timer" : process.platform === "win32" ? "IPC invokes registered Node signal handler" : "native process signal" });
  process.stdout.write(`${JSON.stringify(result.cases.at(-1))}\n`);
}

try {
  for (const [script, reportFile] of [["calibrate.mjs", NETWORK_CALIBRATION_FILE], ["probe-self-test.mjs", NETWORK_SELF_TEST_FILE]]) {
    for (const reason of ["SIGINT", "SIGTERM", "deadline"]) await run(script, reportFile, reason);
  }
  result.status = "complete";
} catch (error) { result.status = "failed"; result.error = error instanceof Error ? error.message.split(/\r?\n/)[0] : "Interrupt regression failed"; process.exitCode = 1; }
finally {
  await writeNetworkReport(path.resolve(directory, "../../../temp/performance/network-interruptions.json"), result);
  process.stdout.write(`${JSON.stringify({ status: result.status, cases: result.cases.length, error: result.error })}\n`);
}
