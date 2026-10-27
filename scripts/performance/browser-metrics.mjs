export async function installBrowserMetrics(page) {
  await page.evaluate(() => {
    const svg = document.querySelector('svg[aria-label="Холст доски"]');
    const camera = svg?.querySelector(':scope > g[style*="scale"]');
    if (!camera) throw new Error("The production SVG camera group was not found");
    const previewGroup = camera.querySelector(":scope > g[data-preview-group]");
    let active = false;
    let previousFrame = null;
    let pendingInput = null;
    let pendingOrdinal = 0;
    let pendingDragInput = null;
    let pointerOrigin = null;
    let previewDelta;
    let retainedNodes = [];
    let start = 0;
    let data;
    let frame;
    const tick = (timestamp) => {
      if (active && previousFrame !== null) data.frames.push(timestamp - previousFrame);
      previousFrame = active ? timestamp : null;
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    svg.addEventListener("pointermove", (event) => {
      if (!active || event.buttons !== 1) return;
      const now = performance.now();
      const timestamp = event.timeStamp <= now && now - event.timeStamp < 60_000 ? event.timeStamp : now;
      data.inputs += 1;
      if (pendingInput === null) {
        pendingInput = timestamp;
        pendingOrdinal = data.inputs;
      }
      if (data.firstMoveMs === null) data.firstMoveMs = timestamp - start;
      if (data.dragIntentMs === null && pointerOrigin &&
          Math.hypot(event.clientX - pointerOrigin.x, event.clientY - pointerOrigin.y) >= 3) {
        data.dragIntentMs = timestamp - start;
      }
      if (data.dragIntentMs !== null && pendingDragInput === null) pendingDragInput = timestamp;
      if (data.inputTrace.length < 12) data.inputTrace.push({ ordinal: data.inputs, eventMs: event.timeStamp - start,
        processingLagMs: now - event.timeStamp, x: event.clientX, y: event.clientY, captured: svg.hasPointerCapture(event.pointerId) });
    }, { capture: true });
    for (const type of ["pointerdown", "pointerup", "pointercancel", "gotpointercapture", "lostpointercapture", "pointerleave"]) {
      svg.addEventListener(type, (event) => {
        if (active && type === "pointerdown" && event.buttons === 1) {
          pointerOrigin = { x: event.clientX, y: event.clientY };
          data.pointerDownMs = event.timeStamp - start;
        }
        if (active && data.pointerEvents.length < 100) data.pointerEvents.push({ type, buttons: event.buttons,
          target: event.target.localName, x: event.clientX, y: event.clientY, timestamp: event.timeStamp });
      }, { capture: true });
    }
    const observer = new MutationObserver((records) => {
      if (!active || pendingInput === null) return;
      if (camera.getAttribute("data-board-layers") === "true") {
        const transformed = previewGroup && records.some((record) => record.target === previewGroup && record.attributeName === "transform");
        if (!transformed && !records.some((record) => record.target === camera && record.attributeName === "style")) return;
        const delta = [camera.style.getPropertyValue("--rimo-preview-x"), camera.style.getPropertyValue("--rimo-preview-y")];
        if (!transformed && delta.every((value, index) => value === previewDelta[index])) return;
        previewDelta = delta;
      } else {
        const overlay = camera.querySelector(":scope > g[transform]");
        if (!overlay || !records.some((record) => record.target === overlay && record.attributeName === "transform")) return;
      }
      data.firstPreviewRetainedContent ??= retainedNodes.filter((node) => node.isConnected).length;
      data.firstPreviewContentByKind ??= { math: retainedNodes.filter((node) => node.matches(".katex") && node.isConnected).length,
        images: retainedNodes.filter((node) => node.localName === "img" && node.isConnected).length };
      const input = pendingInput;
      const inputOrdinal = pendingOrdinal;
      const dragInput = pendingDragInput;
      const appliedAtInputOrdinal = data.inputs;
      const mutationMs = performance.now() - start;
      pendingInput = null;
      pendingDragInput = null;
      requestAnimationFrame((timestamp) => {
        if (!active) return;
        const latencyMs = timestamp - input;
        const ordinal = data.reactions.length;
        data.reactions.push(latencyMs);
        if (dragInput !== null) data.dragReactions.push(timestamp - dragInput);
        if (data.firstPreviewMs === null) data.firstPreviewMs = timestamp - start;
        if (data.reactionTrace.length < 8 || (latencyMs > 50 && data.reactionTrace.length < 32)) {
          data.reactionTrace.push({ ordinal, inputOrdinal, appliedAtInputOrdinal, inputMs: input - start,
            dragInputMs: dragInput === null ? null : dragInput - start,
            mutationMs, frameMs: timestamp - start, latencyMs,
            dragLatencyMs: dragInput === null ? null : timestamp - dragInput });
        }
      });
    });
    observer.observe(camera, { attributes: true, subtree: true, attributeFilter: ["transform", "style"] });
    const supported = PerformanceObserver.supportedEntryTypes ?? [];
    const entries = (items) => {
      if (!active) return;
      for (const entry of items) {
        if (entry.startTime < start) continue;
        if (entry.entryType === "longtask") data.longTasks.push(entry.duration);
        if (entry.entryType === "event") data.eventTiming.push({ name: entry.name, duration: entry.duration,
          inputDelay: entry.processingStart - entry.startTime, processing: entry.processingEnd - entry.processingStart });
      }
    };
    const observers = [];
    for (const type of ["longtask", "event"]) {
      if (!supported.includes(type)) continue;
      const performanceObserver = new PerformanceObserver((list) => entries(list.getEntries()));
      try { performanceObserver.observe({ type, buffered: false, ...(type === "event" ? { durationThreshold: 16 } : {}) }); observers.push(performanceObserver); }
      catch { performanceObserver.disconnect(); }
    }
    window.__rimoPerformance = {
      start() {
        retainedNodes = [...camera.querySelectorAll(".katex, img")];
        previewDelta = [camera.style.getPropertyValue("--rimo-preview-x"), camera.style.getPropertyValue("--rimo-preview-y")];
        data = { frames: [], reactions: [], dragReactions: [], inputs: 0, longTasks: [], eventTiming: [],
          pointerEvents: [], inputTrace: [], reactionTrace: [], firstMoveMs: null, pointerDownMs: null,
          dragIntentMs: null, firstPreviewMs: null, firstPreviewRetainedContent: null,
          contentNodesBefore: retainedNodes.length, firstPreviewContentByKind: null,
          contentNodesByKind: { math: retainedNodes.filter((node) => node.matches(".katex")).length,
            images: retainedNodes.filter((node) => node.localName === "img").length },
          layout: previewGroup ? "stable-shared-group" : camera.getAttribute("data-board-layers") === "true" ? "stable-keyed-layers" : "group-overlay" };
        previousFrame = null; pendingInput = null; pendingDragInput = null; pointerOrigin = null;
        start = performance.now(); active = true;
      },
      stop() {
        observers.forEach((entry) => entries(entry.takeRecords()));
        active = false;
        return { ...data, elapsedMs: performance.now() - start,
          contentNodesRetainedAfter: retainedNodes.filter((node) => node.isConnected).length, eventTimingSupported: supported.includes("event"),
          contentNodesAfterByKind: { math: retainedNodes.filter((node) => node.matches(".katex") && node.isConnected).length,
            images: retainedNodes.filter((node) => node.localName === "img" && node.isConnected).length },
          startup: { screenThresholdPx: 3,
            firstMoveToThresholdMs: data.dragIntentMs === null || data.firstMoveMs === null ? null : data.dragIntentMs - data.firstMoveMs,
            pointerDownToThresholdMs: data.dragIntentMs === null || data.pointerDownMs === null ? null : data.dragIntentMs - data.pointerDownMs,
            firstMoveToPreviewMs: data.firstPreviewMs === null || data.firstMoveMs === null ? null : data.firstPreviewMs - data.firstMoveMs,
            thresholdToPreviewMs: data.firstPreviewMs === null || data.dragIntentMs === null ? null : data.firstPreviewMs - data.dragIntentMs } };
      },
      dispose() { active = false; cancelAnimationFrame(frame); observer.disconnect(); observers.forEach((entry) => entry.disconnect()); },
    };
  });
}

export async function browserEnvironment(page, browser) {
  return { version: browser.version(), viewport: page.viewportSize(), headless: true, deviceScaleFactor: 1,
    ...(await page.evaluate(() => {
      const context = document.createElement("canvas").getContext("webgl");
      const extension = context?.getExtension("WEBGL_debug_renderer_info");
      return { userAgent: navigator.userAgent, devicePixelRatio: devicePixelRatio,
        renderer: extension ? context.getParameter(extension.UNMASKED_RENDERER_WEBGL) : null,
        fonts: [...document.fonts].filter((font) => font.status === "loaded").map((font) => font.family).filter((font, index, values) => values.indexOf(font) === index) };
    })) };
}

export async function renderedObjects(page) {
  return page.evaluate(() => {
    const camera = document.querySelector('svg[aria-label="Холст доски"] > g[style*="scale"]');
    if (camera.getAttribute("data-board-layers") === "true") {
      const layers = camera.querySelector(":scope > g[data-preview-group]") ?? camera;
      return layers.querySelectorAll(":scope > g[data-layer-id]").length;
    }
    return [...camera.children].filter((element) => element.tagName.toLowerCase() === "g" && element.childElementCount > 0).length;
  });
}
