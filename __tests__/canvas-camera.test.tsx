import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useCanvasCamera } from "@/app/board/[boardId]/_hooks/use-canvas-camera";

vi.mock("@/hooks/use-board-bounds", () => ({
  useBoardBounds: () => ({ x: 100, y: 100, width: 400, height: 200 }),
}));

let svg: SVGSVGElement;
let frames: Map<number, FrameRequestCallback>;
let sequence: number;
let now: number;

beforeEach(() => {
  svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  Object.defineProperties(svg, { clientWidth: { value: 1000 }, clientHeight: { value: 700 } });
  svg.getBoundingClientRect = () => ({ left: 20, top: 30 }) as DOMRect;
  frames = new Map();
  sequence = 0;
  now = 0;
  vi.spyOn(performance, "now").mockImplementation(() => now);
  vi.stubGlobal("requestAnimationFrame", vi.fn((callback: FrameRequestCallback) => { frames.set(++sequence, callback); return sequence; }));
  vi.stubGlobal("cancelAnimationFrame", vi.fn((id: number) => frames.delete(id)));
});

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function setup(onManualNavigation?: () => void) {
  const ref = { current: svg };
  return renderHook(() => useCanvasCamera(ref, onManualNavigation));
}

function advanceFrame(milliseconds: number): void {
  now = milliseconds;
  const pending = [...frames.values()];
  frames.clear();
  act(() => pending.forEach((callback) => callback(now)));
}

describe("manual navigation and camera animations", () => {
  it("applies a followed camera without reporting manual navigation", () => {
    const manual = vi.fn();
    const { result } = setup(manual);
    act(() => result.current.animateCameraTo({ x: 100, y: 200, scale: 3 }));
    expect(manual).toHaveBeenCalledTimes(1);
    act(() => result.current.applyRemoteCamera({ x: 20, y: 30, scale: 2 }));
    expect(manual).toHaveBeenCalledTimes(1);
    expect(frames.size).toBe(0);
    expect(result.current.cameraRef.current).toEqual({ x: 20, y: 30, scale: 2 });
    act(() => result.current.updateCamera({ x: 30, y: 40, scale: 2 }));
    expect(manual).toHaveBeenCalledTimes(2);
  });

  it("notifies a follower for wheel, fit and toolbar zoom before moving", () => {
    const manual = vi.fn();
    const { result } = setup(manual);
    act(() => svg.dispatchEvent(new WheelEvent("wheel", { deltaY: 40, cancelable: true })));
    expect(manual).toHaveBeenCalledTimes(1);
    act(() => result.current.fitToScreen());
    expect(manual).toHaveBeenCalledTimes(2);
    act(() => result.current.animateCameraTo({ x: 0, y: 0, scale: 2 }));
    expect(manual).toHaveBeenCalledTimes(3);
  });

  it("cancels an in-flight animation when a manual pan or pinch updates the camera", () => {
    const { result } = setup();
    act(() => result.current.animateCameraTo({ x: 100, y: 200, scale: 3 }));
    advanceFrame(50);
    expect(result.current.camera.scale).toBeGreaterThan(1);
    act(() => result.current.updateCamera({ x: 25, y: 30, scale: 1.5 }));
    expect(frames.size).toBe(0);
    advanceFrame(500);
    expect(result.current.camera).toEqual({ x: 25, y: 30, scale: 1.5 });
    expect(result.current.cameraRef.current).toEqual(result.current.camera);
  });

  it("keeps fit-to-screen animated and reaches the computed bounds", () => {
    const { result } = setup();
    act(() => result.current.fitToScreen());
    advanceFrame(250);
    expect(result.current.camera.scale).toBeCloseTo(2.3);
    expect(result.current.camera.x).toBeCloseTo(-190);
    expect(result.current.camera.y).toBeCloseTo(-110);
    expect(frames.size).toBe(0);
  });

  it("keeps wheel navigation and zoom anchoring while interrupting an animation", () => {
    const { result } = setup();
    act(() => result.current.animateCameraTo({ x: 100, y: 200, scale: 3 }));
    const wheel = new WheelEvent("wheel", { deltaX: 25, deltaY: 40, cancelable: true });
    act(() => svg.dispatchEvent(wheel));
    expect(wheel.defaultPrevented).toBe(true);
    expect(result.current.camera).toEqual({ x: -25, y: -40, scale: 1 });
    expect(frames.size).toBe(0);
    act(() => svg.dispatchEvent(new WheelEvent("wheel", { clientX: 220, clientY: 130, deltaY: -1000, ctrlKey: true, cancelable: true })));
    expect(result.current.camera).toEqual({ x: -700, y: -460, scale: 4 });
  });
});
