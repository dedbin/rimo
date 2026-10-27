// @vitest-environment node
import type { PerformanceEntry } from "node:perf_hooks";

import { afterEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  callback: undefined as undefined | ((list: { getEntries(): PerformanceEntry[] }) => void),
  records: [] as PerformanceEntry[],
  loop: { enable: vi.fn(), disable: vi.fn(), count: 0, max: 0, percentile: vi.fn(() => 25_000_000) },
  observe: vi.fn(), disconnect: vi.fn(),
}));
vi.mock("node:perf_hooks", () => ({
  constants: { NODE_PERFORMANCE_GC_MAJOR: 4 },
  monitorEventLoopDelay: () => state.loop,
  PerformanceObserver: class {
    constructor(callback: typeof state.callback) { state.callback = callback; }
    observe = state.observe;
    disconnect = state.disconnect;
    takeRecords(): PerformanceEntry[] { return state.records.splice(0); }
  },
}));
vi.mock("node:process", () => ({ memoryUsage: () => ({ rss: 500, heapUsed: 200, heapTotal: 300,
  external: 40, arrayBuffers: 20, cookie: "must-not-leak" }) }));
vi.mock("node:v8", () => ({ getHeapStatistics: () => ({ heap_size_limit: 800, payload: "must-not-leak" }) }));

import { RuntimeMetrics } from "../collaboration-server/runtime-metrics";

function gc(duration: number, kind = 1): PerformanceEntry {
  return { entryType: "gc", duration, detail: { kind } } as unknown as PerformanceEntry;
}

afterEach(() => {
  state.records = []; state.loop.count = 0; state.loop.max = 0;
  vi.clearAllMocks();
});

describe("private collaboration runtime observations", () => {
  it("whitelists process numbers and preserves missing event-loop observations", () => {
    const runtime = new RuntimeMetrics();
    expect(runtime.read()).toEqual({ version: 1, rssBytes: 500, heapUsedBytes: 200, heapTotalBytes: 300,
      externalBytes: 40, arrayBuffersBytes: 20, heapLimitBytes: 800, eventLoopSamples: 0,
      eventLoopP95Ms: null, eventLoopMaxMs: null, gcCount: 0, gcTotalMs: 0, gcMaxMs: 0,
      majorGcCount: 0, majorGcTotalMs: 0, majorGcMaxMs: 0 });
    expect(JSON.stringify(runtime.read())).not.toContain("must-not-leak");
  });

  it("keeps lifetime loop/GC counters across independent health reads", () => {
    const runtime = new RuntimeMetrics(); runtime.start();
    state.loop.count = 10; state.loop.max = 60_000_000;
    state.records.push(gc(2), gc(11, 4));
    const first = runtime.read(); const second = runtime.read();
    expect(first).toMatchObject({ eventLoopSamples: 10, eventLoopP95Ms: 25, eventLoopMaxMs: 60,
      gcCount: 2, gcTotalMs: 13, gcMaxMs: 11, majorGcCount: 1, majorGcTotalMs: 11, majorGcMaxMs: 11 });
    expect(second).toEqual(first);
    state.callback?.({ getEntries: () => [gc(3, 4)] });
    expect(runtime.read()).toMatchObject({ gcCount: 3, gcTotalMs: 16, majorGcCount: 2, majorGcTotalMs: 14, majorGcMaxMs: 11 });
    runtime.stop();
  });

  it("starts and stops once, drains pending GC, and ignores invalid observations", () => {
    const runtime = new RuntimeMetrics(); runtime.start(); runtime.start();
    state.records.push(gc(4, 4), gc(Number.NaN), gc(-1));
    runtime.stop(); runtime.stop();
    expect(state.loop.enable).toHaveBeenCalledTimes(1);
    expect(state.loop.disable).toHaveBeenCalledTimes(1);
    expect(state.observe).toHaveBeenCalledTimes(1);
    expect(state.disconnect).toHaveBeenCalledTimes(1);
    expect(runtime.read()).toMatchObject({ gcCount: 1, gcTotalMs: 4, majorGcCount: 1 });
  });
});
