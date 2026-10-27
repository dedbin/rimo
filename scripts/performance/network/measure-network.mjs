import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";

import { chromium } from "playwright";

import { api, createBoard, distribution, environment, fail, ownerContext, openProvider, removeBoards, safeError, viewerContext, waitFor, writeReport, Y,
  dockerEnvironment } from "../common.mjs";
import { idAt, imageAsset, seedScene, VIEWPORT } from "../fixture.mjs";
import { inspectProject } from "../service-target.mjs";

import { collaborationRoundTrip, imagesReady, instrument, measureMove, waitUntilUsable } from "./browser-probe.mjs";
import { cleanupStep, NETWORK_CALIBRATION_FILE, NETWORK_GUEST_STATE_FILE, networkSourceHash, startHelper } from "./helper.mjs";
import { createRunLifecycle } from "./lifecycle.mjs";
import { prepareUpperFixture, upperDocumentBudget, validateUpperDocument } from "./upper-fixture.mjs";

const { values } = parseArgs({ options: {
  help: { type: "boolean" }, "allow-service-test": { type: "boolean", default: false },
  "upper-document": { type: "boolean", default: false },
  "base-url": { type: "string", default: "http://localhost:3080" }, "storage-state": { type: "string", default: "temp/performance/network-owner-storage.json" },
  "compose-project": { type: "string", default: "rimo-rework" }, label: { type: "string", default: "network-diagnostic-not-accepted" },
  output: { type: "string", default: "temp/performance/network-service.json" },
} });

if (values.help) process.stdout.write("node --import=tsx scripts/performance/network/measure-network.mjs --allow-service-test --storage-state FILE [--upper-document] [--label LABEL] [--output FILE]\n");
else await main().catch(() => { process.stderr.write("Network acceptance setup failed.\n"); process.exitCode = 1; });

async function main() {
  assert.ok(values["allow-service-test"], "Service test requires an explicit flag");
  assert.equal(new URL(values["base-url"]).origin, "http://localhost:3080", "Only the isolated local Docker test origin is supported");
  const calibration = JSON.parse(await readFile(NETWORK_CALIBRATION_FILE, "utf8"));
  assert.equal(calibration.status, "complete", "Calibrate the network helper before measuring the service");
  const sourceHash = await networkSourceHash();
  assert.equal(calibration.networkSourceSha256, sourceHash, "Network sources changed; recalibrate after the final source freeze");
  assert.ok(["websocketDelayAdded", "httpDelayAdded", "oneAndSixConnectionsShareDownloadCap", "sixConnectionsShareUploadCap"]
    .every((name) => calibration.checks?.[name] === true), "Network calibration checks must all pass before service access");
  const projectBinding = await inspectProject(values["compose-project"]);
  const report = { kind: "two-browser-network-acceptance", status: "running", at: new Date().toISOString(),
    environment: await environment(values.label), service: await dockerEnvironment(values["compose-project"]), networkSourceSha256: sourceHash,
    projectBinding, documentProfile: values["upper-document"] ? "upper-document" : "base",
    calibration, helperAttempts: [], helpers: [], browsers: [], createdBoards: [], coldOpens: [], reopens: [], roundtripMs: [], propagationMs: [], pageErrors: [], cleanup: [],
    manualReviewRequired: ["Reopen heap and time trends: inspect all ten observations; automatic5s checks alone do not establish absence of sustained growth"],
    methodology: {
      firstUsable: "navigation start -> Saved, select tool,500 viewport objects,document.fonts.ready,two rAF; image decode measured separately",
      imageReady: "all50 viewport image nodes decoded and document.fonts.ready",
      cache: "CDP Network.setCacheDisabled(true) before every navigation/reload; server/page caches unchanged",
      heap: "CDP JSHeapUsedSize and DOM counts after image/font settle,500ms idle, before and after explicit V8 GC; not process RSS",
      propagation: "source capture pointerup performance.timeOrigin+now -> peer rectangle persistent style mutation on same host clocks; excludes temporary drag preview",
      roundtrip: "persistence-status stateless request -> cached persisted reply on the existing authenticated browser collaboration socket while idle",
      clients: "two independent Chromium processes, separate owner/anonymous-editor accounts and per-browser network helpers; seed Node provider disconnected before measurement",
      bandwidth: "HTB50Mbit/s aggregate per direction per browser, measured conservative payload in calibration; no CDP network emulation",
    } };
  const helpers = [];
  const browsers = [];
  const contexts = [];
  const pages = [];
  let owner;
  let guest;
  let seed;
  let boardId;
  let scene;
  let finalAudit;
  const lifecycle = createRunLifecycle(10 * 60_000, () => Promise.allSettled(browsers.map((browser) => browser.close())));
  const progress = async (phase) => { report.phase = phase; await writeReport(values.output, report, true); process.stdout.write(`${JSON.stringify({ event: "network_progress", phase })}\n`); };
  try {
    lifecycle.check();
    owner = await ownerContext(values["base-url"], values["storage-state"]);
    guest = await viewerContext(values["base-url"], NETWORK_GUEST_STATE_FILE);
    boardId = await createBoard(owner, `Network acceptance ${Date.now()}`);
    report.createdBoards.push(boardId);
    await progress("fixture-created");
    seed = await openProvider(owner, values["base-url"], boardId, lifecycle.signal);
    const assetUrl = await imageAsset(owner, boardId);
    let upper;
    if (values["upper-document"]) {
      lifecycle.check();
      const prepared = prepareUpperFixture(seed.document, assetUrl);
      lifecycle.check();
      let updates = 0;
      const countUpdate = () => { updates += 1; };
      seed.document.on("update", countUpdate);
      try { Y.applyUpdate(seed.document, prepared.update); }
      finally { seed.document.off("update", countUpdate); }
      assert.equal(updates, 1, "The upper fixture must publish one final update");
      scene = prepared.scene;
      upper = { ...prepared.metadata, ...upperDocumentBudget(Y.encodeStateAsUpdate(seed.document).byteLength), publishedUpdates: updates };
    } else scene = seedScene(seed.document, 3_000, assetUrl);
    await waitFor(() => seed.isPersisted(), 15_000, lifecycle.signal);
    report.fixture = { objects: scene.objects, visibleObjects: scene.visibleObjects, images: scene.visibleDistribution[5],
      documentBytes: Y.encodeStateAsUpdate(seed.document).byteLength, ...(upper ?? {}) };
    await seed.close(); seed = undefined;
    const invite = await api(owner, "POST", `/api/boards/${boardId}/invites`, { role: "editor", expiresInHours: 1 });
    await api(guest.context, "POST", "/api/invites/accept", { token: invite.token, name: "Network fixture editor" });
    for (const [role, state] of [["owner", await owner.storageState()], ["editor", await guest.context.storageState()]]) {
      lifecycle.check();
      const helper = await startHelper(async (descriptor) => { report.helperAttempts.push(descriptor); await writeReport(values.output, report, true); });
      helpers.push(helper); report.helpers.push(helper.metadata);
      lifecycle.check();
      assert.equal(helper.metadata.image, calibration.helper.image, "Calibrate the actual helper image before measuring the service");
      assert.equal(helper.metadata.helperConfigurationSha256, calibration.helper.helperConfigurationSha256, "Network helper configuration changed after calibration");
      await helper.configure([3080], 50);
      const browser = await chromium.launch({ channel: "chromium", headless: true, proxy: helper.proxy,
        handleSIGINT: false, handleSIGTERM: false, handleSIGHUP: false }); browsers.push(browser);
      lifecycle.check();
      report.browsers.push({ role, version: browser.version(), process: "independent Chromium launch", headless: true, viewport: VIEWPORT, deviceScaleFactor: 1 });
      const context = await browser.newContext({ storageState: state, viewport: VIEWPORT, deviceScaleFactor: 1, locale: "ru-RU" }); contexts.push(context);
      const page = await context.newPage(); pages.push(page);
      page.on("pageerror", (error) => report.pageErrors.push(safeError(error)));
      await instrument(page);
      const cdp = await context.newCDPSession(page);
      await cdp.send("Network.enable"); await cdp.send("Network.setCacheDisabled", { cacheDisabled: true });
      await cdp.send("Performance.enable");
      const started = performance.now();
      await page.goto(`${values["base-url"]}/board/${boardId}`, { waitUntil: "domcontentloaded", timeout: 60_000 });
      await waitUntilUsable(page, 500);
      const firstUsableMs = performance.now() - started;
      await imagesReady(page, scene.assetUrl, 50);
      report.coldOpens.push({ role, firstUsableMs, allImagesAndFontsReadyMs: performance.now() - started,
        fonts: await page.evaluate(() => [...document.fonts].map((face) => ({ family: face.family, style: face.style, weight: face.weight, status: face.status }))) });
      await progress(`${role}-cold-opened`);
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
    for (let index = 0; index < 10; index += 1) {
      for (let client = 0; client < pages.length; client += 1) report.roundtripMs.push({ client, value: await collaborationRoundTrip(pages[client], boardId) });
    }
    report.roundtripDistributionMs = distribution(report.roundtripMs.map((entry) => entry.value));
    const rectangle = scene.positions.get(idAt(210));
    for (let trial = 0; trial < 20; trial += 1) {
      lifecycle.check();
      const source = pages[trial % 2]; const peer = pages[1 - trial % 2];
      const value = await measureMove(source, peer, rectangle, 20);
      report.propagationMs.push({ client: trial % 2, value });
      await source.getByText("Сохранено", { exact: true }).waitFor();
      await source.keyboard.press("Control+z");
      await source.getByText("Сохранено", { exact: true }).waitFor();
      await peer.waitForFunction(({ x, y }) => [...document.querySelectorAll('svg[aria-label="Холст доски"] rect.drop-shadow-md')]
        .some((item) => { const matrix = new DOMMatrix(item.style.transform); return matrix.e === x && matrix.f === y; }), rectangle);
    }
    report.propagationDistributionMs = distribution(report.propagationMs.map((entry) => entry.value));
    await progress("twenty-bidirectional-final-moves");
    const cdp = await contexts[0].newCDPSession(pages[0]);
    await cdp.send("Performance.enable");
    const metrics = async () => (await cdp.send("Performance.getMetrics")).metrics.filter((item) => ["JSHeapUsedSize", "JSHeapTotalSize", "Nodes", "Documents", "Frames"].includes(item.name));
    for (let iteration = 0; iteration < 10; iteration += 1) {
      lifecycle.check();
      const started = performance.now();
      await pages[0].reload({ waitUntil: "domcontentloaded", timeout: 60_000 });
      await waitUntilUsable(pages[0], 500);
      const firstUsableMs = performance.now() - started;
      await imagesReady(pages[0], scene.assetUrl, 50);
      const allImagesAndFontsReadyMs = performance.now() - started;
      await new Promise((resolve) => setTimeout(resolve, 500));
      const beforeGc = await metrics();
      await cdp.send("HeapProfiler.collectGarbage");
      report.reopens.push({ iteration: iteration + 1, firstUsableMs, allImagesAndFontsReadyMs, beforeGc, afterGc: await metrics() });
      await progress(`cold-reopen-${iteration + 1}`);
    }
    const trend = (numbers) => {
      const median = (sample) => sample.toSorted((a, b) => a - b)[Math.floor(sample.length / 2)];
      const mean = numbers.reduce((sum, value) => sum + value, 0) / numbers.length;
      const center = (numbers.length - 1) / 2;
      const slope = numbers.reduce((sum, value, index) => sum + (index - center) * (value - mean), 0) /
        numbers.reduce((sum, _value, index) => sum + (index - center) ** 2, 0);
      return { firstThreeMedian: median(numbers.slice(0, 3)), lastThreeMedian: median(numbers.slice(-3)), slopePerReopen: slope };
    };
    report.reopenTrends = { firstUsableMs: trend(report.reopens.map((entry) => entry.firstUsableMs)),
      postGcHeapUsedBytes: trend(report.reopens.map((entry) => entry.afterGc.find((metric) => metric.name === "JSHeapUsedSize").value)),
      interpretation: "ten observations and explicit GC expose a trend; they do not prove absence of leaks or measure complete browser RSS" };
    finalAudit = await openProvider(owner, values["base-url"], boardId, lifecycle.signal);
    assert.equal(finalAudit.document.getMap("layers").size, 3_000);
    for (const [id, original] of scene.positions) {
      const layer = finalAudit.document.getMap("layers").get(id);
      assert.equal(layer.get("x"), original.x); assert.equal(layer.get("y"), original.y);
    }
    if (values["upper-document"]) {
      const finalBytes = validateUpperDocument(finalAudit.document);
      report.fixture.afterMovesAndUndo = { actualDocumentBytes: finalBytes,
        actualSlackBytes: report.fixture.documentLimitBytes - finalBytes, strictValidation: true };
      assert.ok(finalBytes <= report.fixture.documentLimitBytes, "The twenty moves and undo exhausted the document budget");
    }
    report.criteria = { coldFirstUsableWithin5seconds: report.coldOpens.every((entry) => entry.firstUsableMs <= 5_000),
      allTenReopensWithin5seconds: report.reopens.every((entry) => entry.firstUsableMs <= 5_000),
      finalOperationPropagationP95Within300ms: report.propagationDistributionMs.p95 <= 300,
      measuredServiceRoundtripAtLeast90ms: report.roundtripDistributionMs.p50 >= 90,
      noPageErrors: report.pageErrors.length === 0, allOriginalCoordinatesRestoredAndDurable: true };
    report.networkStatistics = await Promise.all(helpers.map((helper) => helper.statistics()));
    lifecycle.check(); report.status = "complete";
    if (!Object.values(report.criteria).every(Boolean)) process.exitCode = 1;
  } catch (error) {
    report.status = "failed"; report.error = safeError(error); process.exitCode = 1;
    if (error?.networkHelper) report.helperRecoveryRequired = error.networkHelper;
  }
  finally {
    const cleanup = async (step, operation) => {
      if (!await cleanupStep(report, step, operation)) { report.status = "failed"; process.exitCode = 1; }
    };
    await Promise.all([cleanup("final audit connection", () => finalAudit?.close()), cleanup("seed connection", () => seed?.close())]);
    await Promise.all(browsers.map((browser, index) => cleanup(`browser-${index}`, () => browser.close())));
    await Promise.all(helpers.map((helper, index) => cleanup(`owned helper-${index}`, () => helper.close())));
    if (owner && boardId) await cleanup("created fixture board", async () => {
      report.boardCleanupFailures = await removeBoards(owner, [boardId]);
      if (report.boardCleanupFailures.length) throw fail("Fixture board cleanup failed");
    });
    await Promise.all([cleanup("owner API context", () => owner?.dispose()), cleanup("guest API context", () => guest?.context.dispose())]);
    lifecycle.apply(report);
    try { await lifecycle.finalize(report, () => writeReport(values.output, report)).catch(() => { process.stderr.write("Could not write the final network report.\n"); process.exitCode = 1; }); }
    finally { lifecycle.dispose(); }
    process.stdout.write(`${JSON.stringify({ status: report.status, criteria: report.criteria,
      coldOpens: report.coldOpens, propagation: report.propagationDistributionMs, roundtrip: report.roundtripDistributionMs })}\n`);
  }
}
