import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { LaserPresence } from "@/app/board/[boardId]/_components/laser-presence";
import type { BoardParticipant } from "@/lib/collaboration/presence";

import { peer, PresentationRuntime } from "./presentation-runtime";

let runtime: PresentationRuntime;
let now: number;
let frames: Map<number, FrameRequestCallback>;
let sequence: number;

beforeEach(() => {
  runtime = new PresentationRuntime();
  now = 0; sequence = 0; frames = new Map();
  vi.spyOn(performance, "now").mockImplementation(() => now);
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { frames.set(++sequence, callback); return sequence; });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
});
afterEach(() => { cleanup(); runtime.board.destroy(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function participant(sequence = 1): BoardParticipant {
  const participant = peer(2);
  return { ...participant, presence: { ...participant.presence, laser: { sequence, points: [{ x: 20, y: 30 }, { x: 40, y: 50 }] } } };
}
function frame(time: number): void {
  now = time;
  const pending = [...frames.values()]; frames.clear();
  act(() => pending.forEach((callback) => callback(time)));
}

describe("ephemeral laser overlay", () => {
  it("fades from receipt of a new sequence and stale full-presence retransmits cannot keep it alive", () => {
    runtime.others = [participant()];
    const { container } = render(<svg><LaserPresence scale={2} /></svg>, { wrapper: runtime.wrapper });
    const trace = () => container.querySelector('[data-laser-id="2"]');
    expect(trace()).not.toBeNull();
    expect(container.querySelector("circle")?.getAttribute("r")).toBe("2.5");
    expect(container.querySelector("path")?.getAttribute("stroke-width")).toBe("2");
    frame(500);
    expect(trace()?.getAttribute("opacity")).toBe("0.5");
    now = 750;
    act(() => runtime.setOthers([participant()]));
    expect(trace()?.getAttribute("opacity")).toBe("0.25");
    frame(1001);
    expect(trace()).toBeNull();
    act(() => runtime.setOthers([participant()]));
    expect(trace()).toBeNull();
    act(() => runtime.setOthers([participant(2)]));
    expect(trace()).not.toBeNull();
  });

  it("clears on null presence and cancels animation frames when a participant leaves", () => {
    runtime.others = [participant()];
    const { container, unmount } = render(<svg><LaserPresence scale={1} /></svg>, { wrapper: runtime.wrapper });
    expect(container.querySelector("[data-laser-dot]")).not.toBeNull();
    act(() => runtime.setOthers([peer(2)]));
    expect(container.querySelector("[data-laser-dot]")).toBeNull();
    expect(frames.size).toBe(0);
    // An obsolete packet following the explicit clear does not resurrect a trail.
    act(() => runtime.setOthers([participant()]));
    expect(container.querySelector("[data-laser-dot]")).toBeNull();
    act(() => runtime.setOthers([participant(2)]));
    expect(frames.size).toBe(1);
    act(() => runtime.setOthers([]));
    expect(frames.size).toBe(0);
    unmount();
    expect(frames.size).toBe(0);
  });
});
