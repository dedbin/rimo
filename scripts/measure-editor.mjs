import path from "node:path";
import { mkdir } from "node:fs/promises";
import { parseArgs } from "node:util";

import { chromium } from "playwright";
import { createDecoder, readVarString, readVarUint } from "lib0/decoding";

import { createBoard, distribution, environment, fail, installLoadInterruptHandlers, openProvider, ownerContext, positiveInteger, removeBoards, safeError, waitFor, writeFinalReport, writeReport, Y } from "./performance/common.mjs";
import { browserEnvironment, installBrowserMetrics, renderedObjects } from "./performance/browser-metrics.mjs";
import { dragOffset, idAt, imageAsset, SCENE_VERSION, seedScene, SELECT_BOX, VIEWPORT, VISIBLE_OBJECTS } from "./performance/fixture.mjs";
import { selfTest } from "./performance/self-test.mjs";

const { values } = parseArgs({ options: {
  help: { type: "boolean" }, "self-test": { type: "boolean" }, "base-url": { type: "string", default: "http://localhost:3000" },
  "storage-state": { type: "string", default: "temp/browser-owner-storage.json" },
  output: { type: "string", default: `temp/performance/editor-${Date.now()}.json` },
  label: { type: "string", default: "local-production-diagnostic" },
  "background-tasks": { type: "string", default: "not recorded" },
  trials: { type: "string", default: "3" }, steps: { type: "string", default: "180" },
  "enforce-budgets": { type: "boolean", default: false },
} });

if (values.help) {
  process.stdout.write("node --import=tsx scripts/measure-editor.mjs [--self-test] [--base-url URL] [--storage-state FILE] [--output FILE] [--label LABEL] [--trials 3] [--steps 180] [--enforce-budgets]\n");
} else if (values["self-test"]) {
  process.stdout.write(`${JSON.stringify(selfTest())}\n`);
} else {
  await main().catch((error) => { process.stderr.write(`${safeError(error)}\n`); process.exitCode = 1; });
}

async function main() {
  await mkdir(path.dirname(path.resolve(values.output)), { recursive: true });
  const trials = positiveInteger(values.trials, "trials", 20);
  const steps = positiveInteger(values.steps, "steps", 2_000);
  const report = { kind: "editor-performance", version: 1, status: "running", targetOrigin: new URL(values["base-url"]).origin, environment: await environment(values.label),
    sceneVersion: SCENE_VERSION, gestureProtocolVersion: 2, methodology: {
      reaction: "capture pointermove -> SVG drag transform mutation -> next requestAnimationFrame; DOM/rAF proxy, not compositor input-to-photon",
      dragReaction: "earliest pending pointermove after the production 3px screen threshold -> transform -> rAF; raw proxy and startup remain separate",
      gesture: "180 moves by default; first move 4px along the trajectory, total displacement120x40; no synthetic warmup or discarded first-preview sample",
      frames: "requestAnimationFrame intervals during the gesture and two settling frames; nearest-rank p95",
      eventTiming: "native Event Timing entries >=16ms, reported separately; pointermove is not covered by this API",
      wire: "Hocuspocus application payload bytes, excluding WebSocket framing, TCP and TLS",
    }, backgroundTasks: values["background-tasks"], trials: [], pageErrors: [], browserProtocolEvents: [], cleanup: [] };
  const boards = [];
  let context;
  let observer;
  let browser;
  let browserContext;
  let page;
  let scene;
  const controller = new AbortController();
  const removeInterruptHandlers = installLoadInterruptHandlers(controller);
  controller.signal.addEventListener("abort", () => { void browser?.close().catch(() => {}); }, { once: true });
  const watchdog = setTimeout(() => { process.exitCode = 1; controller.abort(); }, 120_000);
  watchdog.unref();
  const phase = (name) => { report.phase = name; process.stdout.write(`${JSON.stringify({ event: "editor_progress", phase: name })}\n`); };
  try {
    context = await ownerContext(values["base-url"], values["storage-state"]);
    const boardId = await createBoard(context, `Performance fixture ${Date.now()}`);
    boards.push(boardId);
    report.createdBoards = boards;
    await writeReport(values.output, report);
    phase("fixture-created");
    observer = await openProvider(context, values["base-url"], boardId, controller.signal);
    phase("websocket-connected");
    scene = seedScene(observer.document, 3_000, await imageAsset(context, boardId));
    await waitFor(() => observer.isPersisted());
    phase("fixture-persisted");
    report.fixture = { boardId, objects: scene.objects, visibleObjects: scene.visibleObjects,
      distribution: scene.distribution, visibleDistribution: scene.visibleDistribution, uniqueImages: scene.uniqueImages,
      documentBytes: Y.encodeStateAsUpdate(observer.document).byteLength };
    browser = await chromium.launch({ headless: true, channel: "chromium",
      handleSIGINT: false, handleSIGTERM: false, handleSIGHUP: false });
    controller.signal.throwIfAborted();
    browserContext = await browser.newContext({ storageState: values["storage-state"], viewport: VIEWPORT, deviceScaleFactor: 1, locale: "ru-RU" });
    page = await browserContext.newPage();
    page.on("pageerror", (error) => report.pageErrors.push(safeError(error)));
    page.on("websocket", (socket) => socket.on("framereceived", ({ payload }) => {
      if (typeof payload === "string") return;
      try {
        const decoder = createDecoder(payload); readVarString(decoder);
        if (readVarUint(decoder) !== 7) return;
        const reason = readVarString(decoder);
        const category = /receive.*limit|rate.*limit/i.test(reason) ? "receive-limit"
          : /access.*revoked|unavailable/i.test(reason) ? "access" : /board.*removed/i.test(reason) ? "board-removed" : "other";
        if (report.browserProtocolEvents.length < 100) report.browserProtocolEvents.push({ type: "logical-close", category, at: performance.now() });
      } catch { /* Report only understood protocol categories, never raw payloads. */ }
    }));
    const openedAt = performance.now();
    await page.goto(`${values["base-url"]}/board/${boardId}`, { waitUntil: "networkidle", timeout: 60_000 });
    phase("browser-opened");
    await page.getByText("Сохранено", { exact: true }).waitFor({ timeout: 30_000 });
    phase("browser-saved");
    await page.waitForFunction(({ expected, count }) => {
      const images = [...document.querySelectorAll('svg[aria-label="Холст доски"] foreignObject img')]
        .filter((image) => new URL(image.currentSrc || image.getAttribute("src") || "", location.href).pathname === expected);
      return images.length === count && images.every((image) => image.complete && image.naturalWidth > 0);
    }, { expected: scene.assetUrl, count: scene.visibleDistribution[5] }, { timeout: 5_000 });
    await page.evaluate(async (expected) => {
      const images = [...document.querySelectorAll('svg[aria-label="Холст доски"] foreignObject img')]
        .filter((image) => new URL(image.currentSrc || image.getAttribute("src") || "", location.href).pathname === expected);
      await Promise.race([
        Promise.all([document.fonts.ready, ...images.map((image) => image.decode())]),
        new Promise((_resolve, reject) => setTimeout(() => reject(new Error("Fixture fonts/images did not settle within5 seconds")), 5_000)),
      ]);
    }, scene.assetUrl);
    report.loadedFixtureImages = scene.visibleDistribution[5];
    if (report.loadedFixtureImages !== scene.visibleDistribution[5]) throw fail("The fixture did not decode all50 visible image objects");
    phase("fonts-and-images-ready");
    report.openMs = performance.now() - openedAt;
    report.browser = await browserEnvironment(page, browser);
    report.renderedObjects = await renderedObjects(page);
    if (report.renderedObjects !== VISIBLE_OBJECTS) throw fail(`Expected exactly500 rendered objects, received ${report.renderedObjects}`);
    const svg = page.locator('svg[aria-label="Холст доски"]');
    const bounds = await svg.boundingBox();
    report.canvas = bounds;
    const point = (input) => ({ x: bounds.x + input.x, y: bounds.y + input.y });
    const begin = point(SELECT_BOX.from);
    const end = point(SELECT_BOX.to);
    await page.mouse.move(begin.x, begin.y);
    await page.mouse.down();
    await page.mouse.move(end.x, end.y, { steps: 10 });
    await page.mouse.up();
    const selectedIds = Array.from({ length: VISIBLE_OBJECTS }, (_entry, index) => idAt(index));
    await waitFor(() => [...observer.provider.awareness.getStates()].some(([clientId, state]) => clientId !== observer.document.clientID &&
      state.presence?.selection?.length === VISIBLE_OBJECTS && selectedIds.every((id) => state.presence.selection.includes(id))));
    await waitFor(() => observer.isPersisted());
    await page.getByText("Сохранено", { exact: true }).waitFor();
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await page.locator('button:has(svg[class*="mouse-pointer"])').waitFor({ state: "visible" });
    await installBrowserMetrics(page);
    const heap = await browserContext.newCDPSession(page);
    await heap.send("Performance.enable");
    report.heapBefore = (await heap.send("Performance.getMetrics")).metrics.filter((metric) => ["JSHeapUsedSize", "JSHeapTotalSize", "Nodes"].includes(metric.name));
    let coordinateTransactions = 0;
    let coordinateFields = 0;
    const onTransaction = (transaction) => {
      let fields = 0;
      for (const [type, keys] of transaction.changed) if (type instanceof Y.Map) fields += Number(keys.has("x")) + Number(keys.has("y"));
      if (fields) { coordinateTransactions += 1; coordinateFields += fields; }
    };
    observer.document.on("afterTransaction", onTransaction);
    const moved = (delta) => [...scene.positions].every(([id, original], index) => {
      const layer = observer.document.getMap("layers").get(id);
      const change = index < VISIBLE_OBJECTS ? delta : { x: 0, y: 0 };
      return layer.get("x") === original.x + change.x && layer.get("y") === original.y + change.y;
    });
    for (let trial = 0; trial < trials; trial += 1) {
      controller.signal.throwIfAborted();
      phase(`gesture-${trial + 1}`);
      coordinateTransactions = 0; coordinateFields = 0;
      observer.resetStatistics();
      const dragLayerId = idAt(210);
      const position = scene.positions.get(dragLayerId);
      const start = point({ x: position.x + 13, y: position.y + 11 });
      report.dragTarget = { fixtureId: dragLayerId, screen: start };
      report.lastHitTarget = await page.evaluate((coordinate) => {
        const target = document.elementFromPoint(coordinate.x, coordinate.y);
        return { tag: target?.localName, role: target?.getAttribute("role"), dataLayerId: target?.getAttribute("data-layer-id"),
          isLayerRectangle: target?.matches("rect.drop-shadow-md") ?? false };
      }, start);
      if (!report.lastHitTarget.isLayerRectangle) throw fail("The selected fixture rectangle is covered by an editor overlay");
      await page.mouse.move(start.x, start.y);
      await page.evaluate(() => window.__rimoPerformance.start());
      await page.mouse.down();
      for (let step = 1; step <= steps; step += 1) {
        controller.signal.throwIfAborted();
        const offset = dragOffset(step, steps);
        await page.mouse.move(start.x + offset.x, start.y + offset.y);
        await new Promise((resolve) => setTimeout(resolve, 16));
      }
      const writesBeforeRelease = coordinateTransactions;
      await page.mouse.up();
      await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      const metrics = await page.evaluate(() => window.__rimoPerformance.stop());
      const result = { trial: trial + 1, frameMs: distribution(metrics.frames), reactionProxyMs: distribution(metrics.reactions),
        activeDragReactionProxyMs: distribution(metrics.dragReactions), startup: metrics.startup,
        inputEvents: metrics.inputs, observedInputHz: metrics.inputs / (metrics.elapsedMs / 1_000), elapsedMs: metrics.elapsedMs,
        longTasksMs: distribution(metrics.longTasks), eventTimingSupported: metrics.eventTimingSupported,
        nativeEventTiming: metrics.eventTiming, pointerEvents: metrics.pointerEvents,
        inputTrace: metrics.inputTrace, reactionTrace: metrics.reactionTrace,
        writesBeforeRelease, coordinateTransactions, coordinateFields, wire: observer.stats };
      report.trials.push(result);
      await waitFor(() => moved({ x: 120, y: 40 }) && observer.isPersisted());
      result.coordinateTransactions = coordinateTransactions; result.coordinateFields = coordinateFields; result.wire = observer.stats;
      if (observer.failure) throw fail(observer.failure);
      await page.keyboard.press("Control+z");
      await waitFor(() => moved({ x: 0, y: 0 }) && observer.isPersisted());
      result.singleUndoRestoredAll500 = true;
    }
    report.heapAfter = (await heap.send("Performance.getMetrics")).metrics.filter((metric) => ["JSHeapUsedSize", "JSHeapTotalSize", "Nodes"].includes(metric.name));
    await page.screenshot({ path: path.resolve(values.output).replace(/\.json$/, "") + ".png" });
    report.criteria = { frameP95AtMost33ms: report.trials.every((entry) => entry.frameMs.p95 !== null && entry.frameMs.p95 <= 33),
      localReactionProxyAtMost50ms: report.trials.every((entry) => entry.activeDragReactionProxyMs.count > 0 && entry.activeDragReactionProxyMs.max <= 50),
      oneFinalCoordinateTransaction: report.trials.every((entry) => entry.writesBeforeRelease === 0 && entry.coordinateTransactions === 1),
      noPageErrors: report.pageErrors.length === 0 };
    controller.signal.throwIfAborted();
    report.status = "complete";
    if (values["enforce-budgets"] && !Object.values(report.criteria).every(Boolean)) process.exitCode = 1;
  } catch (error) {
    report.status = "failed"; report.error = safeError(error); process.exitCode = 1;
    if (observer && scene) {
      const deltas = {};
      for (const [id, position] of scene.positions) {
        const layer = observer.document.getMap("layers").get(id);
        const key = layer ? `${layer.get("x") - position.x},${layer.get("y") - position.y}` : "missing";
        deltas[key] = (deltas[key] ?? 0) + 1;
      }
      report.gestureAtFailure = { deltas, observerPersisted: observer.isPersisted(), connectionFailure: observer.failure,
        selectedCounts: [...observer.provider.awareness.getStates().values()].map((entry) => entry.presence?.selection?.length ?? 0) };
    }
    if (page && !page.isClosed()) report.readinessAtFailure = await page.evaluate(() => ({ fonts: document.fonts.status,
      ui: { savedLabelVisible: [...document.querySelectorAll("[data-save-state] span")].some((element) => element.textContent === "Сохранено"),
        disconnectedLabelVisible: [...document.querySelectorAll("[data-save-state] span")].some((element) => element.textContent === "Нет соединения"),
        statusIsAlert: !!document.querySelector('[data-save-state][role="alert"]'), editingToolbarPresent: !!document.querySelector('button svg[class*="mouse-pointer"]') },
      images: [...document.images].map((image) => {
        const pathname = new URL(image.getAttribute("src") ?? "", location.href).pathname;
        return { fixtureAsset: !!image.closest('svg[aria-label="Холст доски"] foreignObject'),
          sourcePath: /^\/api\/assets\/[a-f0-9-]{36}$/.test(pathname) ? pathname : "non-asset-or-placeholder",
          loading: image.loading, complete: image.complete, naturalWidth: image.naturalWidth, display: getComputedStyle(image).display };
      }) })).catch(() => null);
  }
  finally {
    const closing = await Promise.allSettled([browser?.close(), observer?.close()]);
    report.closeErrors = closing.filter((entry) => entry.status === "rejected").map((entry) => safeError(entry.reason));
    if (context) {
      report.cleanup = await removeBoards(context, boards);
      await context.dispose().catch((error) => { report.closeErrors.push(safeError(error)); });
    }
    clearTimeout(watchdog);
    if (report.cleanup.length || report.closeErrors.length) { report.status = "cleanup-failed"; process.exitCode = 1; }
    try { await writeFinalReport(values.output, report, controller.signal); }
    finally { removeInterruptHandlers(); }
  }
}
