import { afterEach, describe, expect, it, vi } from "vitest";

import { installBrowserMetrics } from "../scripts/performance/browser-metrics.mjs";

interface Metrics {
  reactions: number[];
  dragReactions: number[];
  frames: number[];
  startup: { firstMoveToPreviewMs: number; thresholdToPreviewMs: number };
  reactionTrace: Array<{ inputOrdinal: number; appliedAtInputOrdinal: number; inputMs: number;
    mutationMs: number; rafTimestampMs: number; callbackMs: number; latencyMs: number; dragLatencyMs: number }>;
}
interface Meter { start(): void; stop(): Metrics; dispose(): void }

async function timingFixture() {
  document.body.innerHTML = '<svg aria-label="Холст доски"><g data-board-layers="true" ' +
    'style="transform: scale(1); --rimo-preview-x: 0px; --rimo-preview-y: 0px">' +
    '<g data-preview-group="true" transform="translate(0 0)"></g></g></svg>';
  const svg = document.querySelector("svg")!;
  const camera = svg.querySelector("g")!;
  const group = camera.querySelector("g")!;
  const clock = { now: 1_000 };
  const callbacks = new Map<number, FrameRequestCallback>();
  let nextHandle = 0;
  vi.spyOn(performance, "now").mockImplementation(() => clock.now);
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    callbacks.set(++nextHandle, callback); return nextHandle;
  });
  vi.stubGlobal("cancelAnimationFrame", (handle: number) => { callbacks.delete(handle); });
  vi.stubGlobal("PerformanceObserver", class { static supportedEntryTypes = []; });
  Object.defineProperty(svg, "hasPointerCapture", { value: () => false });
  await installBrowserMetrics({ evaluate: async (callback: () => void) => { callback(); } });
  const meter = Reflect.get(window, "__rimoPerformance") as Meter;
  meter.start();
  return { meter, camera, group, clock,
    pointer(type: "pointerdown" | "pointermove", timestamp: number, processedAt: number, x: number) {
      clock.now = processedAt;
      const event = new MouseEvent(type, { bubbles: true, buttons: 1, clientX: x, clientY: 0 });
      Object.defineProperty(event, "timeStamp", { value: timestamp });
      svg.dispatchEvent(event);
    },
    frame(timestamp: number, ...actualCallbackTimes: number[]) {
      const pending = [...callbacks.values()];
      callbacks.clear();
      pending.forEach((callback, index) => {
        clock.now = actualCallbackTimes[index] ?? actualCallbackTimes.at(-1)!;
        callback(timestamp);
      });
    },
  };
}

afterEach(() => {
  const meter = Reflect.get(window, "__rimoPerformance") as Meter | undefined;
  meter?.dispose();
  Reflect.deleteProperty(window, "__rimoPerformance");
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("actual rAF callback timing", () => {
  it("includes callback delay when the shared frame stamp predates the preview mutation", async () => {
    const fixture = await timingFixture();
    fixture.pointer("pointerdown", 1_000, 1_000, 0);
    fixture.pointer("pointermove", 1_010, 1_012, 4);
    fixture.clock.now = 1_030;
    fixture.group.setAttribute("transform", "translate(4 0)");
    await Promise.resolve();
    // Both callbacks receive one frame stamp, but the reaction callback runs later.
    fixture.frame(1_020, 1_040, 1_090);
    fixture.frame(1_036, 1_110);
    const metrics = fixture.meter.stop();

    expect(metrics.reactions).toEqual([80]);
    expect(metrics.dragReactions).toEqual([80]);
    expect(metrics.startup).toMatchObject({ firstMoveToPreviewMs: 80, thresholdToPreviewMs: 80 });
    expect(metrics.reactionTrace[0]).toMatchObject({ inputMs: 10, mutationMs: 30,
      rafTimestampMs: 20, callbackMs: 90, latencyMs: 80, dragLatencyMs: 80 });
    expect(metrics.reactionTrace[0].callbackMs).toBeGreaterThanOrEqual(metrics.reactionTrace[0].mutationMs);
    expect(metrics.frames).toEqual([16]);
  });

  it("keeps the earliest pending input and counts delay even when the frame stamp follows mutation", async () => {
    const fixture = await timingFixture();
    fixture.pointer("pointerdown", 1_000, 1_000, 0);
    fixture.pointer("pointermove", 1_010, 1_012, 4);
    fixture.pointer("pointermove", 1_020, 1_022, 8);
    fixture.clock.now = 1_030;
    fixture.camera.style.setProperty("--rimo-preview-x", "8px");
    await Promise.resolve();
    fixture.frame(1_040, 1_045, 1_080);
    const metrics = fixture.meter.stop();

    expect(metrics.reactions).toEqual([70]);
    expect(metrics.dragReactions).toEqual([70]);
    expect(metrics.reactionTrace[0]).toMatchObject({ inputOrdinal: 1, appliedAtInputOrdinal: 2, inputMs: 10,
      mutationMs: 30, rafTimestampMs: 40, callbackMs: 80, latencyMs: 70, dragLatencyMs: 70 });
  });
});
