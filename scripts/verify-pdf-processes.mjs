import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs, promisify } from "node:util";

import { createBoard, distribution, environment, fail, installLoadInterruptHandlers, openProvider,
  ownerContext, positiveInteger, removeBoards, safeError, waitFor, writeReport } from "./performance/common.mjs";
import { imageAsset } from "./performance/fixture.mjs";
import { controlImage, prepareSnapshot, seedLesson } from "./performance/pdf-lesson/fixture.mjs";
import { verifyPdf } from "./performance/pdf-lesson/pdf.mjs";
import { startProbe } from "./performance/pdf-lesson/probe.mjs";
import { inspectProject } from "./performance/service-target.mjs";

const execute = promisify(execFile);
const PROCESS_SOURCE = String.raw`
  const fs = require('node:fs/promises');
  (async () => {
    const [current, maximum, peak, events, init, names] = await Promise.all([
      fs.readFile('/sys/fs/cgroup/pids.current','utf8'), fs.readFile('/sys/fs/cgroup/pids.max','utf8'),
      fs.readFile('/sys/fs/cgroup/pids.peak','utf8'), fs.readFile('/sys/fs/cgroup/pids.events','utf8'),
      fs.readFile('/proc/1/comm','utf8'), fs.readdir('/proc')]);
    let zombies = 0;
    for (const name of names.filter(name => /^[0-9]+$/.test(name))) {
      let stat;
      try { stat = await fs.readFile('/proc/'+name+'/stat','utf8'); }
      catch(error) { if(error.code === 'ENOENT') continue; throw error; }
      if(stat.slice(stat.lastIndexOf(')')+1).trim().split(/\s+/)[0] === 'Z') zombies++;
    }
    process.stdout.write(JSON.stringify({pidsCurrent:Number(current),pidsLimit:Number(maximum),pidsPeak:Number(peak),
      limitEvents:Number(/^max\s+(\d+)$/m.exec(events)?.[1]),zombies,initCommand:init.trim()}));
  })().catch(() => { process.exitCode = 1; });
`;

const { values } = parseArgs({ options: {
  help: { type: "boolean" }, "allow-service-test": { type: "boolean", default: false },
  exports: { type: "string", default: "100" }, "compose-project": { type: "string", default: "rimo-rework" },
  "storage-state": { type: "string", default: "temp/docker-owner-storage.json" },
  "pdf-python": { type: "string", default: process.env.RIMO_PDF_PYTHON ?? "python3" },
  output: { type: "string", default: `temp/pdf-process-lifecycle/run-${randomUUID()}/report.json` },
} });

if (values.help) {
  process.stdout.write("node --import=tsx scripts/verify-pdf-processes.mjs --allow-service-test [--exports 100] [--compose-project NAME] [--storage-state FILE] [--pdf-python PATH] [--output temp/NEW/report.json]\n");
} else {
  await main().catch(() => { process.stderr.write("PDF process verification could not start.\n"); process.exitCode = 1; });
}

async function processSample(binding, signal) {
  const { stdout } = await execute("docker", ["exec", binding.worker.id, "node", "-e", PROCESS_SOURCE],
    { windowsHide: true, timeout: 10_000, maxBuffer: 32_768, signal });
  const value = JSON.parse(stdout);
  for (const field of ["pidsCurrent", "pidsLimit", "pidsPeak", "limitEvents", "zombies"]) {
    assert.ok(Number.isSafeInteger(value[field]) && value[field] >= 0, "Invalid process observation");
  }
  assert.equal(value.pidsLimit, 256, "Keep the original worker process limit");
  assert.ok(value.pidsCurrent > 0 && value.pidsCurrent <= value.pidsLimit);
  assert.equal(value.initCommand, "docker-init", "The selected worker must use Docker init");
  return value;
}

async function main() {
  assert.ok(values["allow-service-test"], "Explicit service-test opt-in is required");
  const count = positiveInteger(values.exports, "exports", 200);
  assert.ok(count >= 100, "At least 100 sequential exports are required");
  const output = path.resolve(values.output);
  const root = path.resolve("temp/pdf-process-lifecycle");
  assert.ok(output.startsWith(root + path.sep) && output.endsWith(".json"));
  await mkdir(path.dirname(output), { recursive: true });
  const parent = await realpath(path.dirname(output));
  assert.ok(parent.toLowerCase().startsWith(root.toLowerCase() + path.sep));
  await writeFile(output, "{}\n", { flag: "wx", mode: 0o600 });
  const directory = path.join(path.dirname(output), `pdf-${randomUUID()}`);
  await mkdir(directory);
  const controller = new AbortController();
  const removeSignals = installLoadInterruptHandlers(controller);
  const deadline = setTimeout(() => controller.abort(), 300_000);
  const report = { kind: "pdf-process-lifecycle", version: 1, status: "running", at: new Date().toISOString(),
    requestedExports: count, exports: [], samples: [], cleanup: [],
    methodology: {
      stimulus: "100 or more public sequential exports of one fixed 20-page snapshot; no worker restart, parallel jobs, hidden retry or artificial delay",
      process: "read-only cgroup-v2 PID counters and proc state after each response; original pids limit256, sandbox and memory limits retained",
      verification: "every body checks PDF signature, size and fixed revision; first and last are independently checked by pypdf/pdfminer for 20 pages, Russian text and order",
      scope: "operator API requests, not browser interaction or a latency acceptance profile; per-response process sampling adds overhead",
    } };
  let owner; let seed; let probe; let boardId;
  const cleanup = async (step, action) => {
    try { await action(); report.cleanup.push({ step, status: "complete" }); }
    catch { report.cleanup.push({ step, status: "failed" }); }
  };
  try {
    report.environment = await environment("repeated-public-pdf-processes");
    report.harnessSha256 = createHash("sha256").update(await readFile(new URL(import.meta.url))).digest("hex");
    const binding = await inspectProject(values["compose-project"]);
    report.projectBinding = binding;
    const inspected = await execute("docker", ["inspect", "--format",
      '{"image":{{json .Image}},"init":{{json .HostConfig.Init}}}', binding.worker.id],
    { windowsHide: true, timeout: 10_000, maxBuffer: 4_096, signal: controller.signal });
    const configuration = JSON.parse(inspected.stdout);
    assert.equal(configuration.image, binding.worker.imageId); assert.equal(configuration.init, true);
    owner = await ownerContext("http://localhost:3080", values["storage-state"]);
    boardId = await createBoard(owner, `PDF process fixture ${randomUUID()}`);
    report.createdBoard = boardId;
    seed = await openProvider(owner, "http://localhost:3080", boardId, controller.signal);
    const [baseAsset, pdfAsset] = await Promise.all([imageAsset(owner, boardId), controlImage(owner, boardId)]);
    const scene = seedLesson(seed.document, baseAsset, pdfAsset);
    await waitFor(() => seed.isPersisted(), 15_000, controller.signal);
    const snapshot = await prepareSnapshot(owner, boardId, scene, seed.acknowledgement.revision);
    report.snapshot = { revision: snapshot.revision, pages: snapshot.pages.length, expiresAt: snapshot.expiresAt };
    await seed.close(); seed = undefined;
    report.cleanup.push({ step: "fixture provider", status: "complete" });
    probe = await startProbe(binding, controller.signal);
    await probe.waitState(false);
    report.memoryBefore = await probe.memoryNow();
    report.samples.push({ afterExport: 0, ...await processSample(binding, controller.signal) });
    for (let index = 1; index <= count; index += 1) {
      controller.signal.throwIfAborted(); probe.check();
      const started = performance.now();
      const response = await owner.post(`/api/boards/${boardId}/pdf`, { data: { token: snapshot.token, acceptWarnings: true }, timeout: 40_000 });
      try {
        assert.equal(response.status(), 200, "Public PDF did not complete");
        assert.equal(response.headers()["content-type"], "application/pdf");
        assert.equal(response.headers()["x-rimo-revision"], String(snapshot.revision));
        const bytes = await response.body();
        assert.ok(bytes.length >= 5 && bytes.length <= 32 * 1024 * 1024);
        assert.equal(bytes.subarray(0, 5).toString("ascii"), "%PDF-");
        const result = { index, milliseconds: performance.now() - started, bytes: bytes.length,
          sha256: createHash("sha256").update(bytes).digest("hex"), revision: snapshot.revision };
        if (index === 1 || index === count) {
          const file = path.join(directory, `control-${index}.pdf`);
          await writeFile(file, bytes, { flag: "wx", mode: 0o600 }); result.file = file;
        }
        report.exports.push(result);
      } finally { await response.dispose(); }
      await probe.waitState(false, probe.sequence());
      report.samples.push({ afterExport: index, ...await processSample(binding, controller.signal) });
      if (index % 10 === 0) {
        await writeReport(output, report, true);
        process.stdout.write(`${JSON.stringify({ event: "pdf_process_progress", completed: index, requested: count })}\n`);
      }
    }
    report.memoryAfter = await probe.memoryNow();
    await probe.close(); probe = undefined;
    report.cleanup.push({ step: "worker probe", status: "complete" });
    for (const entry of [report.exports[0], report.exports.at(-1)]) entry.verified = await verifyPdf(values["pdf-python"], entry.file);
    const first = report.samples[0]; const last = report.samples.at(-1);
    report.durationMs = distribution(report.exports.map((entry) => entry.milliseconds));
    report.criteria = {
      allDeclaredExportsCompleted: report.exports.length === count,
      eachExportWithin30Seconds: report.exports.every((entry) => entry.milliseconds <= 30_000),
      firstAndLastTwentyPagesVerified: [report.exports[0], report.exports.at(-1)].every((entry) => entry.verified?.pages === 20),
      noPidLimitEvents: report.samples.every((entry) => entry.limitEvents === first.limitEvents) && first.limitEvents === 0,
      noZombieAccumulation: report.samples.every((entry) => entry.zombies === 0),
      idlePidsRemainBounded: last.pidsCurrent <= first.pidsCurrent + 8,
      workerNodeMemoryRecorded: [report.memoryBefore, report.memoryAfter].every((entry) =>
        Number.isSafeInteger(entry?.workerPid) && entry.workerPid > 1 && entry.workerRssBytes > 0),
    };
    report.status = Object.values(report.criteria).every(Boolean) ? "accepted" : "not-accepted";
  } catch (error) { report.status = "failed"; report.error = safeError(error); }
  finally {
    if (probe) await cleanup("worker probe", () => probe.close());
    if (seed) await cleanup("fixture provider", () => seed.close());
    if (owner && boardId) await cleanup("created board and assets", async () => {
      if ((await removeBoards(owner, [boardId])).length) throw fail("Fixture board cleanup failed");
      assert.equal((await owner.get(`/api/boards/${boardId}/session`)).status(), 404);
    });
    if (owner) await cleanup("owner API context", () => owner.dispose());
    if (controller.signal.aborted) { report.status = "interrupted"; report.interrupted = true; }
    if (report.cleanup.some((entry) => entry.status !== "complete")) report.status = "cleanup-failed";
    clearTimeout(deadline); removeSignals();
    await writeReport(output, report, true);
    process.stdout.write(`${JSON.stringify({ report: path.relative(process.cwd(), output), status: report.status,
      completed: report.exports.length, criteria: report.criteria ?? {} })}\n`);
    if (report.status !== "accepted") process.exitCode = 1;
  }
}
