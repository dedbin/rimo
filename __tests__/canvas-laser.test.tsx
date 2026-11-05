import type { PointerEvent } from "react";
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useCanvasLaser } from "@/app/board/[boardId]/_hooks/use-canvas-laser";

import { PresentationRuntime } from "./presentation-runtime";

let runtime: PresentationRuntime;
let svg: SVGSVGElement;
let now: number;
const cameraRef = { current: { x: 20, y: 10, scale: 2 } };

beforeEach(() => {
  cameraRef.current = { x: 20, y: 10, scale: 2 };
  runtime = new PresentationRuntime();
  svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  const captured = new Set<number>();
  Object.assign(svg, { setPointerCapture: (id: number) => captured.add(id),
    releasePointerCapture: (id: number) => captured.delete(id), hasPointerCapture: (id: number) => captured.has(id),
    getBoundingClientRect: () => ({ left: 10, top: 20 }) });
  now = 0;
  vi.useFakeTimers();
  vi.spyOn(performance, "now").mockImplementation(() => now);
});
afterEach(() => { cleanup(); runtime.board.destroy(); vi.useRealTimers(); vi.restoreAllMocks(); });

function event(x = 100, pointerId = 1, pointerType = "mouse"): PointerEvent<SVGSVGElement> {
  return { clientX: x, clientY: 150, pointerId, pointerType, button: 0, preventDefault: vi.fn() } as unknown as PointerEvent<SVGSVGElement>;
}
function setup() {
  return renderHook(({ active }: { active: boolean }) => useCanvasLaser({ active, svgRef: { current: svg }, cameraRef }),
    { wrapper: runtime.wrapper, initialProps: { active: true } });
}
function advance(milliseconds: number): void { now += milliseconds; act(() => vi.advanceTimersByTime(milliseconds)); }

describe("laser gesture lifecycle", () => {
  it("keeps an active laser under a stationary mouse after the camera moves, without creating one on hover", () => {
    const { result } = setup();
    act(() => result.current.refreshPointer(event()));
    expect(runtime.self.presence.laser).toBeUndefined();
    act(() => result.current.onPointerDown(event()));
    cameraRef.current = { x: -20, y: 10, scale: 2 };
    act(() => result.current.refreshPointer(event(100, 2)));
    advance(50);
    expect(runtime.self.presence.laser?.points.at(-1)).toEqual({ x: 35, y: 60 });
    act(() => result.current.refreshPointer(event()));
    advance(50);
    expect(runtime.self.presence.laser?.points.at(-1)).toEqual({ x: 55, y: 60 });
    act(() => result.current.onPointerUp(event()));
    act(() => result.current.refreshPointer(event()));
    expect(runtime.self.presence.laser).toBeNull();
    expect(runtime.board.undoManager.undoStack).toHaveLength(0);
  });

  it("transmits bounded board-space samples at most twenty times per second without document edits", () => {
    const { result } = setup();
    const updates = vi.fn(); runtime.board.doc.on("update", updates);
    act(() => result.current.onPointerDown(event()));
    expect(runtime.self.presence.laser?.points).toEqual([{ x: 35, y: 60 }]);
    for (let index = 0; index < 100; index += 1) act(() => result.current.onPointerMove(event(101 + index)));
    expect(runtime.updatePresence).toHaveBeenCalledTimes(1);
    advance(50);
    expect(runtime.updatePresence).toHaveBeenCalledTimes(2);
    expect(runtime.self.presence.laser?.points).toHaveLength(32);
    expect(runtime.self.presence.laser?.points.at(-1)).toEqual({ x: 85, y: 60 });
    expect(updates).not.toHaveBeenCalled();
    expect(runtime.board.undoManager.undoStack).toHaveLength(0);
  });

  it("clears on pointer up, tool change and blur, without reusing an old sequence", () => {
    const { result, rerender } = setup();
    act(() => result.current.onPointerDown(event()));
    const first = runtime.self.presence.laser!.sequence;
    act(() => result.current.onPointerUp(event()));
    expect(runtime.self.presence.laser).toBeNull();
    advance(50);
    act(() => result.current.onPointerDown(event(200)));
    expect(runtime.self.presence.laser!.sequence).toBeGreaterThan(first);
    rerender({ active: false });
    expect(runtime.self.presence.laser).toBeNull();
    rerender({ active: true });
    advance(50);
    act(() => result.current.onPointerDown(event(300)));
    act(() => window.dispatchEvent(new Event("blur")));
    expect(runtime.self.presence.laser).toBeNull();
    expect(svg.hasPointerCapture(1)).toBe(false);
  });

  it("cancels the first touch when a second arrives and ignores the surviving finger until all contacts lift", () => {
    const { result } = setup();
    act(() => result.current.onPointerDown(event(100, 1, "touch")));
    act(() => result.current.onPointerDown(event(200, 2, "touch")));
    expect(runtime.self.presence.laser).toBeNull();
    act(() => result.current.onPointerUp(event(200, 2, "touch")));
    advance(50);
    act(() => result.current.onPointerMove(event(300, 1, "touch")));
    expect(runtime.self.presence.laser).toBeNull();
    act(() => result.current.onPointerUp(event(300, 1, "touch")));
    act(() => result.current.onPointerDown(event(400, 3, "touch")));
    expect(runtime.self.presence.laser).not.toBeNull();
  });

  it("ignores foreign pointer cancellation and palm contacts while a pen owns the laser", () => {
    const { result } = setup();
    act(() => result.current.onPointerDown(event(100, 9, "pen")));
    act(() => result.current.onPointerDown(event(200, 1, "touch")));
    act(() => result.current.onPointerDown(event(210, 2, "touch")));
    act(() => result.current.onPointerCancel(event(210, 2, "touch")));
    act(() => result.current.onPointerLeave(event(220, 3)));
    expect(runtime.self.presence.laser).not.toBeNull();
    act(() => result.current.onPointerCancel(event(230, 9, "pen")));
    expect(runtime.self.presence.laser).toBeNull();
  });

  it("clears pending laser before a quick reconnect and removes every timer/listener on unmount", () => {
    const { result, unmount } = setup();
    act(() => result.current.onPointerDown(event()));
    act(() => result.current.onPointerMove(event(200)));
    act(() => runtime.setState({ connected: false, synced: false }));
    expect(runtime.self.presence.laser).toBeNull();
    act(() => runtime.setState({ connected: true, synced: true }));
    advance(50);
    expect(runtime.self.presence.laser).toBeNull();
    unmount();
    expect(vi.getTimerCount()).toBe(0);
    expect(runtime.stateListeners.size).toBe(0);
  });
});
