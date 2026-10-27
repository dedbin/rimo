// @vitest-environment node
import { expect, it, vi } from "vitest";

const observation = vi.hoisted(() => ({
  sample: vi.fn(),
}));
vi.mock("../scripts/performance/runtime-sample.mjs", () => ({ sampleCollaborationRuntime: observation.sample }));

import { Y } from "../scripts/performance/common.mjs";
import { idAt, seedScene } from "../scripts/performance/fixture.mjs";
import { runLoad } from "../scripts/performance/load-runner.mjs";

it("captures runtime after a failed load without counting diagnostic time as writer cadence", async () => {
  let now = 1_000;
  const clock = vi.spyOn(performance, "now").mockImplementation(() => now);
  const document = new Y.Doc();
  seedScene(document, 1, "/api/assets/00000000-0000-4000-8000-000000000000");
  const runtime = { available: true, metrics: { gcMaxMs: 3_500, eventLoopMaxMs: 3_700 } };
  observation.sample.mockImplementation(async () => { now = 5_000; return runtime; });
  const peer = {
    document, boardId: "fixture", session: { role: "owner" }, provider: {}, stats: {},
    get failure(): string { now = 1_100; return "Connection closed (1000/access-unavailable)"; },
    resetStatistics(): void {},
  };
  try {
    expect(document.getMap("layers").has(idAt(0))).toBe(true);
    const result = await runLoad([{ boardId: "fixture", clients: [peer], writers: [peer] }], {
      batchSize: 1, objects: 1, batchEverySeconds: 30, seconds: 60, editHz: 2,
      presenceHz: 10, sampleSeconds: 10, composeProject: "fixture",
    }, new AbortController().signal, async () => undefined);
    expect(result.error).toBe("Connection closed (1000/access-unavailable)");
    expect(result.samples).toEqual([]);
    expect(result.runtimeAfterLoad).toEqual(runtime);
    expect(result.steadyDurationSeconds).toBe(0.1);
    expect(result.actualEditsPerWriterHz).toBe(0);
    expect(result.durationSeconds).toBe(4);
    expect(observation.sample).toHaveBeenCalledOnce();
    expect(observation.sample).toHaveBeenCalledWith("fixture");
  } finally { document.destroy(); clock.mockRestore(); observation.sample.mockReset(); }
});
