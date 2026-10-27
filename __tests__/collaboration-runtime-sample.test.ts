// @vitest-environment node
import { describe, expect, it, vi } from "vitest";

import { sampleCollaborationRuntime, validatedRuntimeMetrics } from "../scripts/performance/runtime-sample.mjs";

function metrics() {
  return { version: 1, rssBytes: 500, heapUsedBytes: 200, heapTotalBytes: 300, externalBytes: 40,
    arrayBuffersBytes: 20, heapLimitBytes: 800, eventLoopSamples: 10, eventLoopP95Ms: 25, eventLoopMaxMs: 60,
    gcCount: 3, gcTotalMs: 16, gcMaxMs: 11, majorGcCount: 2, majorGcTotalMs: 14, majorGcMaxMs: 11 };
}

function runner(result: unknown, identity = { project: "fixture", service: "app" }) {
  return vi.fn(async (_program: string, args: string[]) => ({ stdout: args[0] === "ps" ? "a".repeat(64) :
    JSON.stringify(args[0] === "inspect" ? identity : result), stderr: "" }));
}

describe("bounded collaboration runtime sampling", () => {
  it("preserves an optional server timestamp without fabricating it for older images", () => {
    expect(validatedRuntimeMetrics({ ...metrics(), processUptimeMs: 12_500 })).toMatchObject({ processUptimeMs: 12_500 });
    expect(validatedRuntimeMetrics(metrics())).not.toHaveProperty("processUptimeMs");
    for (const value of [-1, 1.5, Number.NaN]) {
      expect(() => validatedRuntimeMetrics({ ...metrics(), processUptimeMs: value })).toThrow();
    }
  });

  it("reads a selected app container and retains metrics from an unhealthy backend", async () => {
    const run = runner({ httpStatus: 503, status: "unavailable", runtime: { ...metrics(), cookie: "private" } });
    expect(await sampleCollaborationRuntime("fixture", run)).toEqual({ available: true, httpStatus: 503, healthy: false, metrics: metrics() });
    expect(run).toHaveBeenCalledTimes(3);
    expect(run.mock.calls[2][1].slice(0, 4)).toEqual(["exec", "a".repeat(64), "node", "-e"]);
    for (const call of run.mock.calls) expect(call[1].join(" ")).not.toContain(".Config.Env");
  });

  it("does not fabricate zeros for older/unavailable backend metrics", async () => {
    expect(await sampleCollaborationRuntime(undefined)).toEqual({ available: false, reason: "compose-project-not-selected" });
    expect(await sampleCollaborationRuntime("fixture", runner({ httpStatus: 200, status: "ok" })))
      .toEqual({ available: false, reason: "runtime-sample-unavailable" });
    expect(await sampleCollaborationRuntime("fixture", vi.fn(async () => { throw new Error("cookie=private"); })))
      .toEqual({ available: false, reason: "runtime-sample-unavailable" });
  });

  it("rejects wrong container ownership before exec", async () => {
    const run = runner({}, { project: "foreign", service: "app" });
    expect(await sampleCollaborationRuntime("fixture", run)).toMatchObject({ available: false });
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("bounds the complete ps/inspect/exec sequence by one ten-second deadline", async () => {
    const clock = vi.spyOn(performance, "now").mockReturnValueOnce(0).mockReturnValueOnce(100)
      .mockReturnValueOnce(200).mockReturnValueOnce(10_001);
    const run = runner({ httpStatus: 200, status: "ok", runtime: metrics() });
    try {
      expect(await sampleCollaborationRuntime("fixture", run)).toMatchObject({ available: false });
      expect(run).toHaveBeenCalledTimes(2);
    } finally { clock.mockRestore(); }
  });

  it.each(["rssBytes", "heapUsedBytes", "eventLoopSamples", "gcCount", "gcTotalMs"])("rejects malformed %s", (field) => {
    expect(() => validatedRuntimeMetrics({ ...metrics(), [field]: Number.NaN })).toThrow();
    expect(() => validatedRuntimeMetrics({ ...metrics(), [field]: -1 })).toThrow();
  });

  it("rejects inconsistent counters and preserves a genuinely empty histogram", () => {
    expect(() => validatedRuntimeMetrics({ ...metrics(), majorGcCount: 4 })).toThrow();
    expect(() => validatedRuntimeMetrics({ ...metrics(), eventLoopP95Ms: 70 })).toThrow();
    expect(() => validatedRuntimeMetrics({ ...metrics(), heapUsedBytes: 301 })).toThrow();
    expect(() => validatedRuntimeMetrics({ ...metrics(), gcCount: 1.5 })).toThrow();
    expect(() => validatedRuntimeMetrics({ ...metrics(), eventLoopSamples: 0 })).toThrow();
    expect(validatedRuntimeMetrics({ ...metrics(), eventLoopSamples: 0, eventLoopP95Ms: null, eventLoopMaxMs: null }))
      .toMatchObject({ eventLoopSamples: 0, eventLoopP95Ms: null, eventLoopMaxMs: null });
  });
});
