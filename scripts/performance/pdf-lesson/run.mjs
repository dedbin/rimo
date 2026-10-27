import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";

import { chromium } from "playwright";

import { api, createBoard, distribution, dockerEnvironment, dockerSample, environment, fail, openProvider, ownerContext, positiveInteger,
  removeBoards, safeError, viewerContext, waitFor, writeReport, Y } from "../common.mjs";
import { idAt, imageAsset, VIEWPORT } from "../fixture.mjs";
import { collaborationRoundTrip, imagesReady, instrument, measureMove, waitUntilUsable } from "../network/browser-probe.mjs";
import { cleanupStep, NETWORK_CALIBRATION_FILE, NETWORK_GUEST_STATE_FILE, networkSourceHash, startHelper } from "../network/helper.mjs";
import { createRunLifecycle } from "../network/lifecycle.mjs";
import { inspectProject } from "../service-target.mjs";
import { reservePdfDirectory } from "./artifacts.mjs";
import { acceptanceStatus, clockBounds, criteria, overlapEvidence } from "./criteria.mjs";
import { auditLesson, controlImage, prepareSnapshot, seedLesson } from "./fixture.mjs";
import { downloadPdf, pdfTools, verifyPdf } from "./pdf.mjs";
import { startProbe } from "./probe.mjs";

const { values } = parseArgs({ options: {
  help: { type: "boolean" }, "allow-service-test": { type: "boolean", default: false }, exports: { type: "string", default: "20" },
  "base-url": { type: "string", default: "http://localhost:3080" }, "compose-project": { type: "string", default: "rimo-rework" },
  "storage-state": { type: "string", default: "temp/performance/network-owner-storage.json" },
  "guest-storage-state": { type: "string", default: NETWORK_GUEST_STATE_FILE },
  "pdf-python": { type: "string", default: process.env.RIMO_PDF_PYTHON ?? "python" },
  label: { type: "string", default: "pdf-lesson-explicit-stress" }, output: { type: "string" },
} });
if (values.help) process.stdout.write("node --import=tsx scripts/performance/pdf-lesson/run.mjs --allow-service-test --storage-state PRIVATE_FILE [--exports 20] [--pdf-python PATH] [--label LABEL] [--output temp/FILE.json]\n20 sequential public 20-page exports by default; two proxied Chromium processes. Run only in an agreed quiet window.\n");
else await main().catch((error) => { process.stderr.write(`${safeError(error)}\n`); process.exitCode = 1; });

async function sourceHash() {
  const directory = fileURLToPath(new URL(".", import.meta.url));
  const hash = createHash("sha256");
  for (const filename of (await readdir(directory)).filter((name) => name.endsWith(".mjs")).toSorted()) {
    hash.update(filename); hash.update(await readFile(path.join(directory, filename)));
  }
  for (const filename of ["scripts/performance/service-target.mjs", "__tests__/pdf-fixtures.ts", "__tests__/pdf-readability.py"]) { hash.update(filename); hash.update(await readFile(filename)); }
  return hash.digest("hex");
}

function refreshMetrics(report) {
  if (report.probe.echoes?.length) report.probe.clock = clockBounds(report.probe.echoes);
  for (const operation of report.operations) operation.overlap = report.probe.clock ? overlapEvidence(operation, report.probe.samples, report.probe.clock) : null;
  report.fullPropagation = distribution(report.operations.map((entry) => entry.propagationMs).filter(Number.isFinite));
  report.overlapPropagation = distribution(report.operations.filter((entry) => entry.overlap !== null).map((entry) => entry.propagationMs).filter(Number.isFinite));
  report.roundtrip = distribution(report.roundtripMs.map((entry) => entry.value));
  report.criteria = criteria(report);
}

async function main() {
  if (!values["allow-service-test"]) throw fail("PDF lesson service test requires explicit --allow-service-test and an agreed run window");
  const requestedExports = positiveInteger(values.exports, "exports", 100);
  assert.equal(new URL(values["base-url"]).origin, "http://localhost:3080", "Only the isolated local Docker test origin is supported");
  const calibration = JSON.parse(await readFile(NETWORK_CALIBRATION_FILE, "utf8"));
  assert.equal(calibration.status, "complete", "Calibrate the existing network helper before PDF lesson acceptance");
  assert.ok(Object.values(calibration.checks ?? {}).length >= 4 && Object.values(calibration.checks).every(Boolean), "Network calibration checks must all pass");
  const networkHash = await networkSourceHash();
  assert.equal(calibration.networkSourceSha256, networkHash, "Network sources changed since calibration");
  const output = path.resolve(values.output ?? `temp/performance/pdf-lesson/${randomUUID()}/report.json`);
  assert.ok(output.startsWith(`${path.resolve("temp")}${path.sep}`), "PDF lesson artifacts must remain inside temp");
  await mkdir(path.dirname(output), { recursive: true });
  const claim = await open(output, "wx", 0o600); await claim.close();
  const report = { kind: "pdf-parallel-two-browser-lesson", status: "running", at: new Date().toISOString(), requestedExports,
    environment: null, service: null, harnessSha256: null,
    networkSourceSha256: networkHash, calibration, helperAttempts: [], helpers: [], browsers: [], createdBoards: [], operations: [],
    roundtripMs: [], pageErrors: [], cleanup: [], probe: {},
    methodology: { stimulus: "declared sequential exports, one public request at a time; same fixed 20-page snapshot; no hidden retry or artificial print delay",
      input: "one alternating owner/editor 20px move per export; peer persistent style mutation minus source pointerup; one undo after each, both Saved",
      pdf: "prepare/inspect before timing via owner API; POST download via real owner Chromium fetch and proxy; Blob download to local file, no PDF bytes in JSON",
      overlap: "pointerup inside conservative two-observation worker /healthz running interval; read-only 25ms probe inside worker namespace; queue occupancy proxy, not CPU print",
      clocks: "probe clock-echo host bounds before/after, 1ms resolution allowance; browser performance epoch checked against Date.now with <=5ms tolerance",
      network: "two existing calibrated helpers, 100ms added RTT/50Mbit per browser; both HTTP and WebSocket go through proxy; no CDP emulation",
      memory: "cgroup current/peak/limit and PID1 RSS sampled read-only; probe process adds overhead; before/immediate-after/5s-idle snapshots, no forced worker GC" },
    manualReviewRequired: ["Inspect worker memory series before/after 20 declared jobs; samples and cgroup history do not prove absence of leaks or VPS capacity"] };
  const browsers = []; const helpers = []; const contexts = []; const pages = []; const pendingDownloads = new Set();
  let owner; let guest; let seed; let audit; let probe; let boardId; let scene; let snapshot;
  const lifecycle = createRunLifecycle(10 * 60_000, async () => {
    await Promise.allSettled([...browsers.map((browser) => browser.close()), ...(probe ? [probe.close()] : [])]);
  });
  const progress = async (phase) => { report.phase = phase; await writeReport(output, report, true);
    process.stdout.write(`${JSON.stringify({ event: "pdf_lesson_progress", phase })}\n`); };
  try {
    lifecycle.check();
    await progress("preflight");
    report.environment = await environment(values.label); report.service = await dockerEnvironment(values["compose-project"]);
    report.projectBinding = await inspectProject(values["compose-project"]);
    report.harnessSha256 = await sourceHash(); report.pdfTools = await pdfTools(values["pdf-python"]);
    report.pdfArtifactDirectory = await reservePdfDirectory(output);
    lifecycle.check();
    owner = await ownerContext(values["base-url"], values["storage-state"]);
    guest = await viewerContext(values["base-url"], values["guest-storage-state"]);
    boardId = await createBoard(owner, `PDF lesson fixture ${Date.now()}`); report.createdBoards.push(boardId);
    await progress("fixture-created");
    const [baseAssetUrl, pdfAssetUrl] = await Promise.all([imageAsset(owner, boardId), controlImage(owner, boardId)]);
    seed = await openProvider(owner, values["base-url"], boardId, lifecycle.signal);
    scene = seedLesson(seed.document, baseAssetUrl, pdfAssetUrl);
    await waitFor(() => seed.isPersisted(), 15_000, lifecycle.signal);
    const minimumRevision = seed.acknowledgement.revision;
    report.fixture = { ...scene.summary, documentBytes: Y.encodeStateAsUpdate(seed.document).byteLength };
    await seed.close(); seed = undefined;
    const invite = await api(owner, "POST", `/api/boards/${boardId}/invites`, { role: "editor", expiresInHours: 1 });
    await api(guest.context, "POST", "/api/invites/accept", { token: invite.token, name: "PDF lesson fixture editor" });
    for (const [role, state] of [["owner", await owner.storageState()], ["editor", await guest.context.storageState()]]) {
      lifecycle.check();
      const helper = await startHelper(async (descriptor) => { report.helperAttempts.push(descriptor); await writeReport(output, report, true); });
      helpers.push(helper); report.helpers.push(helper.metadata);
      assert.equal(helper.metadata.image, calibration.helper.image); assert.equal(helper.metadata.helperConfigurationSha256, calibration.helper.helperConfigurationSha256);
      await helper.configure([3080], 50);
      const browser = await chromium.launch({ channel: "chromium", headless: true, proxy: helper.proxy,
        handleSIGINT: false, handleSIGTERM: false, handleSIGHUP: false }); browsers.push(browser);
      lifecycle.check();
      const context = await browser.newContext({ storageState: state, viewport: VIEWPORT, deviceScaleFactor: 1, locale: "ru-RU", acceptDownloads: true }); contexts.push(context);
      const page = await context.newPage(); pages.push(page);
      page.setDefaultTimeout(15_000);
      page.on("pageerror", (error) => report.pageErrors.push(safeError(error)));
      await instrument(page);
      await page.goto(`${values["base-url"]}/board/${boardId}`, { waitUntil: "domcontentloaded", timeout: 60_000 });
      await waitUntilUsable(page, 500); await imagesReady(page, baseAssetUrl, 50);
      report.browsers.push({ role, version: browser.version(), process: "independent Chromium launch", viewport: VIEWPORT, headless: true });
      await progress(`${role}-ready`);
    }
    snapshot = await prepareSnapshot(owner, boardId, scene, minimumRevision);
    report.snapshot = { revision: snapshot.revision, savedAt: snapshot.savedAt, expiresAt: snapshot.expiresAt, pages: snapshot.pages.length, warningCount: snapshot.warnings.length };
    for (let round = 0; round < 5; round += 1) for (let client = 0; client < 2; client += 1) {
      report.roundtripMs.push({ phase: "before", client, value: await collaborationRoundTrip(pages[client], boardId) });
    }
    probe = await startProbe(report.projectBinding, lifecycle.signal);
    report.probe = { container: probe.container, intervalMs: 25, samples: probe.samples, memory: probe.memory, echoes: probe.echoes };
    report.probe.clock = clockBounds(probe.echoes);
    report.memoryBefore = await probe.memoryNow();
    report.dockerBefore = await dockerSample(values["compose-project"]);
    await progress("fixed-snapshot-and-probe-ready");
    const rectangle = scene.positions.get(idAt(210));
    for (let index = 0; index < requestedExports; index += 1) {
      lifecycle.check(); probe.check();
      await probe.waitState(false, Math.max(0, probe.sequence() - 1));
      const source = pages[index % 2]; const peer = pages[1 - index % 2];
      await source.evaluate(() => { window.__rimoNetwork.pointerUpAt = null; });
      const operation = { index: index + 1, source: index % 2 === 0 ? "owner" : "editor", probeStartSequence: probe.sequence(),
        pointerUpAt: null, receivedAt: null, propagationMs: null, saved: false, undoRestored: false, overlap: null, pdf: null };
      report.operations.push(operation);
      const filename = path.join(report.pdfArtifactDirectory, `control-${String(index + 1).padStart(3, "0")}.pdf`);
      const downloading = downloadPdf(pages[0], boardId, snapshot, filename).then((result) => { operation.pdf = result; return result; },
        (error) => { operation.pdfError = safeError(error); return null; });
      pendingDownloads.add(downloading); void downloading.finally(() => pendingDownloads.delete(downloading));
      await waitFor(() => { probe.check(); return operation.pdf !== null || !!operation.pdfError ||
        probe.samples.some((entry) => entry.sequence > operation.probeStartSequence && entry.ok && entry.running); }, 5_000, lifecycle.signal);
      operation.inputStartEpochMs = Date.now();
      try { operation.propagationMs = await measureMove(source, peer, rectangle, 20); }
      finally {
        const timing = await source.evaluate(() => ({ pointerUpAt: window.__rimoNetwork.pointerUpAt,
          browserClockDifferenceMs: Date.now() - (performance.timeOrigin + performance.now()) }));
        operation.pointerUpAt = timing.pointerUpAt; operation.browserClockDifferenceMs = timing.browserClockDifferenceMs;
        const received = await peer.evaluate(() => ({ at: window.__rimoNetwork.receivedAt,
          clockDifferenceMs: Date.now() - (performance.timeOrigin + performance.now()) }));
        operation.receivedAt = received.at; operation.peerClockDifferenceMs = received.clockDifferenceMs;
      }
      await Promise.all(pages.map((page) => page.getByText("Сохранено", { exact: true }).waitFor())); operation.saved = true;
      await source.keyboard.press("Control+z");
      await Promise.all(pages.map((page) => page.waitForFunction(({ x, y }) => [...document.querySelectorAll('svg[aria-label="Холст доски"] rect.drop-shadow-md')]
        .some((item) => { const matrix = new DOMMatrix(item.style.transform); return matrix.e === x && matrix.f === y; }), rectangle)));
      await Promise.all(pages.map((page) => page.getByText("Сохранено", { exact: true }).waitFor())); operation.undoRestored = true;
      if (!await downloading) throw fail("A public PDF export failed");
      await probe.waitState(false, probe.sequence());
      operation.probeEndSequence = probe.sequence();
      await progress(`export-and-lesson-${index + 1}`);
    }
    report.memoryImmediateAfter = await probe.memoryNow();
    for (let round = 0; round < 5; round += 1) for (let client = 0; client < 2; client += 1) {
      report.roundtripMs.push({ phase: "after", client, value: await collaborationRoundTrip(pages[client], boardId) });
    }
    await new Promise((resolve) => setTimeout(resolve, 5_000));
    lifecycle.check(); report.memoryAfterFiveSecondIdle = await probe.memoryNow();
    report.probe.clock = await probe.clock();
    report.dockerAfter = await dockerSample(values["compose-project"]);
    report.networkStatistics = await Promise.all(helpers.map((helper) => helper.statistics()));
    await probe.close();
    for (const operation of report.operations) {
      lifecycle.check();
      try { operation.pdf.verified = await verifyPdf(values["pdf-python"], operation.pdf.file); }
      catch (error) { operation.pdf.verificationError = safeError(error); }
    }
    audit = await openProvider(owner, values["base-url"], boardId, lifecycle.signal);
    report.durable = { ...auditLesson(audit.document, scene), persisted: audit.isPersisted(), revision: audit.acknowledgement.revision };
    refreshMetrics(report); report.status = acceptanceStatus(report.criteria, report.cleanup);
    if (report.status !== "accepted") process.exitCode = 1;
  } catch (error) { report.status = "failed"; report.error = safeError(error); process.exitCode = 1;
    if (error?.networkHelper) report.helperRecoveryRequired = error.networkHelper;
  } finally {
    const cleanup = async (step, operation) => { if (!await cleanupStep(report, step, operation)) { report.status = "cleanup-failed"; process.exitCode = 1; } };
    await Promise.all([cleanup("seed provider", () => seed?.close()), cleanup("audit provider", () => audit?.close())]);
    await Promise.all(browsers.map((browser, index) => cleanup(`browser-${index}`, () => browser.close())));
    await cleanup("pending public PDF requests", () => Promise.allSettled([...pendingDownloads]));
    await cleanup("worker read-only probe", () => probe?.close());
    await Promise.all(helpers.map((helper, index) => cleanup(`owned network helper-${index}`, () => helper.close())));
    if (owner && boardId) await cleanup("created lesson board", async () => {
      report.boardCleanupFailures = await removeBoards(owner, [boardId]);
      if (report.boardCleanupFailures.length) throw fail("Own lesson board cleanup failed");
    });
    await Promise.all([cleanup("owner API context", () => owner?.dispose()), cleanup("guest API context", () => guest?.context.dispose())]);
    if (report.status === "accepted") report.status = acceptanceStatus(report.criteria, report.cleanup);
    lifecycle.apply(report);
    try { await lifecycle.finalize(report, () => {
      refreshMetrics(report);
      if (report.status === "accepted") report.status = acceptanceStatus(report.criteria, report.cleanup);
      return writeReport(output, report);
    }); }
    finally { lifecycle.dispose(); }
    process.stdout.write(`${JSON.stringify({ status: report.status, criteria: report.criteria, fullPropagation: report.fullPropagation,
      overlapPropagation: report.overlapPropagation, completedExports: report.operations.filter((entry) => entry.pdf?.verified?.pages === 20).length })}\n`);
  }
}
