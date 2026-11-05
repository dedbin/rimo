import { act, cleanup } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { CanvasPointerSample } from "@/lib/board/pointer-sample";
import type { Point } from "@/types/board-canvas";

import { AutoPanFixture } from "./auto-pan-fixture";

let fixture: AutoPanFixture;

beforeEach(() => { fixture = new AutoPanFixture(); });
afterEach(() => {
  cleanup();
  fixture.restore();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function leave(options: Partial<CanvasPointerSample> = {}, target: EventTarget = fixture.body): void {
  fixture.hit = null;
  fixture.pointer("pointerout", { clientX: 1021, relatedTarget: null, ...options }, target);
}

describe("auto-pan across browser and monitor boundaries", () => {
  it("starts immediately on a fast center-to-exit movement without dwelling in the edge zone", () => {
    fixture.setup();
    fixture.pointer("pointermove", { clientX: 520 });
    leave();
    fixture.runFrames(2);
    expect(fixture.cameraRef.current.x).toBeLessThan(10);
    expect(fixture.now).toBe(32);
    expect(fixture.onCameraMoved).not.toHaveBeenCalled();
    const first = fixture.cameraRef.current.x;
    fixture.runFrames();
    expect(fixture.cameraRef.current.x).toBeLessThan(first);
  });

  it("continues from a native leave containing the last inside point without requiring an exact edge hit", () => {
    fixture.setup();
    fixture.pointer("pointermove", { clientX: 520 });
    leave({ clientX: 900 });
    fixture.runFrames(2);
    expect(fixture.cameraRef.current.x).toBeLessThan(10);
    const before = fixture.cameraRef.current.x;
    fixture.advance();
    expect(fixture.cameraRef.current.x - before).toBeCloseTo(-7.68);
    expect(fixture.onCameraMoved).not.toHaveBeenCalled();
  });

  it("treats a physical exit after a click as immediate movement rather than waiting for a second click", () => {
    fixture.setup();
    fixture.pointer("pointermove", { clientX: 520 });
    fixture.canPan.mockReturnValue(false);
    fixture.pointer("pointerdown", { buttons: 1, clientX: 520 });
    fixture.pointer("pointerup", { clientX: 520 });
    fixture.canPan.mockReturnValue(true);
    leave();
    fixture.runFrames(2);
    expect(fixture.cameraRef.current.x).toBeLessThan(10);
    expect(fixture.now).toBe(32);
  });

  it.each<{ exit: Point; direction: Point }>([
    { exit: { x: 1021, y: 380 }, direction: { x: -1, y: 0 } },
    { exit: { x: 19, y: 380 }, direction: { x: 1, y: 0 } },
    { exit: { x: 520, y: 29 }, direction: { x: 0, y: 1 } },
    { exit: { x: 520, y: 731 }, direction: { x: 0, y: -1 } },
  ])("continues through edge $exit at 480 screen pixels per second", ({ exit, direction }) => {
    fixture.setup();
    fixture.pointer("pointermove", { clientX: 520 });
    leave({ clientX: exit.x, clientY: exit.y });
    fixture.runFrames(2);
    const before = { ...fixture.cameraRef.current };
    fixture.advance();
    expect(fixture.cameraRef.current.x - before.x).toBeCloseTo(direction.x * 7.68);
    expect(fixture.cameraRef.current.y - before.y).toBeCloseTo(direction.y * 7.68);
    expect(fixture.cameraRef.current.scale).toBe(2);
    expect(fixture.onCameraMoved).not.toHaveBeenCalled();
  });

  it("keeps diagonal exit speed capped instead of speeding up at a corner", () => {
    fixture.setup();
    fixture.pointer("pointermove", { clientX: 520 });
    leave({ clientX: 1021, clientY: 731 });
    fixture.runFrames(2);
    const before = { ...fixture.cameraRef.current };
    fixture.advance();
    const delta = { x: fixture.cameraRef.current.x - before.x, y: fixture.cameraRef.current.y - before.y };
    expect(delta.x).toBeLessThan(0);
    expect(delta.y).toBeLessThan(0);
    expect(delta.x).toBeCloseTo(delta.y);
    expect(Math.hypot(delta.x, delta.y)).toBeCloseTo(7.68);
  });

  it.each([0.1, 4])("bounds a delayed outside frame without changing scale %s", (scale) => {
    fixture.cameraRef.current = { x: 10, y: 20, scale };
    fixture.setup();
    fixture.pointer("pointermove", { clientX: 520 });
    leave();
    fixture.runFrames(2);
    const before = fixture.cameraRef.current.x;
    fixture.advance(1000);
    expect(fixture.cameraRef.current.x - before).toBeCloseTo(-15.36);
    expect(fixture.cameraRef.current).toMatchObject({ y: 20, scale });
  });

  it("stops on return to the center and resumes from a new edge movement", () => {
    fixture.setup();
    fixture.pointer();
    leave();
    fixture.runFrames();
    fixture.hit = fixture.body;
    fixture.pointer("pointermove", { clientX: 520 });
    fixture.runFrames();
    const stoppedAt = fixture.cameraRef.current.x;
    expect(fixture.frames.size).toBe(0);
    fixture.runFrames();
    expect(fixture.cameraRef.current.x).toBe(stoppedAt);
    fixture.pointer();
    fixture.runFrames();
    expect(fixture.cameraRef.current.x).toBeLessThan(stoppedAt);
  });

  it("does not create a collaborative ghost cursor while the mouse is outside", () => {
    fixture.setup();
    fixture.pointer();
    fixture.runFrames();
    expect(fixture.onCameraMoved).toHaveBeenCalled();
    const refreshed = fixture.onCameraMoved.mock.calls.length;
    leave();
    const before = fixture.cameraRef.current.x;
    fixture.runFrames();
    expect(fixture.cameraRef.current.x).toBeLessThan(before);
    expect(fixture.onCameraMoved).toHaveBeenCalledTimes(refreshed);
  });

  it("ends outside scrolling if document focus is lost without a blur event", () => {
    fixture.setup();
    fixture.pointer();
    leave();
    fixture.runFrames();
    fixture.hasFocus.mockReturnValue(false);
    const stoppedAt = fixture.cameraRef.current.x;
    fixture.runFrames();
    expect(fixture.cameraRef.current.x).toBe(stoppedAt);
    expect(fixture.frames.size).toBe(0);
    fixture.hasFocus.mockReturnValue(true);
    act(() => window.dispatchEvent(new Event("focus")));
    fixture.pointer("pointerenter");
    fixture.pointer("pointerdown", { buttons: 1 });
    fixture.pointer("pointerup");
    fixture.runFrames();
    expect(fixture.cameraRef.current.x).toBe(stoppedAt);
    fixture.hit = fixture.body;
    fixture.pointer();
    fixture.runFrames();
    expect(fixture.cameraRef.current.x).toBeLessThan(stoppedAt);
  });

  it("resets a latched outside direction on window resize and waits for a fresh mousemove", () => {
    fixture.setup();
    fixture.pointer();
    leave();
    fixture.runFrames();
    fixture.svg.getBoundingClientRect = (): DOMRect => new DOMRect(20, 30, 1600, 700);
    act(() => window.dispatchEvent(new Event("resize")));
    const stoppedAt = fixture.cameraRef.current.x;
    fixture.pointer("pointerenter");
    fixture.runFrames();
    expect(fixture.cameraRef.current.x).toBe(stoppedAt);
    expect(fixture.frames.size).toBe(0);
    fixture.hit = fixture.body;
    fixture.pointer("pointermove", { clientX: 40 });
    fixture.runFrames();
    expect(fixture.cameraRef.current.x).toBeGreaterThan(stoppedAt);
  });

  it("accepts a fresh physical SVG exit after reset without requiring a prior hover movement", () => {
    const { result } = fixture.setup();
    fixture.pointer();
    act(() => result.current.reset());
    leave();
    fixture.runFrames(2);
    expect(fixture.cameraRef.current.x).toBeLessThan(10);
  });

  it.each(["disabled", "blocked", "blur", "hidden", "escape", "wheel", "cancel"])("clears outside continuation on %s", (reason) => {
    const { rerender } = fixture.setup();
    fixture.pointer();
    leave();
    fixture.runFrames();
    if (reason === "disabled") rerender({ enabled: false, blocked: false });
    if (reason === "blocked") rerender({ enabled: true, blocked: true });
    act(() => {
      if (reason === "blur") window.dispatchEvent(new Event("blur"));
      if (reason === "hidden") {
        vi.spyOn(document, "hidden", "get").mockReturnValue(true);
        document.dispatchEvent(new Event("visibilitychange"));
      }
      if (reason === "escape") document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
      if (reason === "wheel") fixture.svg.dispatchEvent(new WheelEvent("wheel", { deltaY: 20, bubbles: true }));
      if (reason === "cancel") fixture.pointer("pointercancel");
    });
    const stoppedAt = fixture.cameraRef.current.x;
    fixture.runFrames();
    expect(fixture.cameraRef.current.x).toBe(stoppedAt);
    expect(fixture.frames.size).toBe(0);
    if (reason === "hidden") vi.spyOn(document, "hidden", "get").mockReturnValue(false);
    rerender({ enabled: true, blocked: false });
    fixture.pointer("pointerenter");
    fixture.pointer("pointerup");
    fixture.runFrames();
    expect(fixture.cameraRef.current.x).toBe(stoppedAt);
    fixture.hit = fixture.body;
    fixture.pointer();
    fixture.runFrames();
    expect(fixture.cameraRef.current.x).toBeLessThan(stoppedAt);
  });

  it("updates a captured drag with raw coordinates outside even without a pointerout event", () => {
    fixture.setup();
    fixture.pointer("pointermove", { clientX: 520, buttons: 1, pressure: 0.7 });
    fixture.captured.add(7);
    fixture.hit = null;
    fixture.pointer("pointermove", { clientX: 1450, buttons: 1, pressure: 0.7, shiftKey: true });
    fixture.runFrames(2);
    expect(fixture.cameraRef.current.x).toBeLessThan(10);
    expect(fixture.onCameraMoved).toHaveBeenLastCalledWith(expect.objectContaining({
      pointerId: 7, pointerType: "mouse", clientX: 1450, clientY: 380,
      buttons: 1, pressure: 0.7, shiftKey: true,
    }));
    fixture.pointer("pointerup", { clientX: 1450 });
    fixture.captured.delete(7);
    fixture.pointer("lostpointercapture", { clientX: 1450 });
    const releasedAt = fixture.cameraRef.current.x;
    const refreshed = fixture.onCameraMoved.mock.calls.length;
    fixture.runFrames();
    expect(fixture.cameraRef.current.x).toBeLessThan(releasedAt);
    expect(fixture.onCameraMoved).toHaveBeenCalledTimes(refreshed);
  });

  it("captures a fast drag leaving the viewport even when native relatedTarget is the document element", () => {
    fixture.onPointerExit.mockImplementation((sample) => {
      fixture.calls.push("exit");
      fixture.captured.add(sample.pointerId);
    });
    fixture.setup();
    fixture.pointer("pointermove", { clientX: 520, buttons: 1 });
    fixture.hit = null;
    const rawX = window.innerWidth + 100;
    fixture.pointer("pointerout", { clientX: rawX, buttons: 1, pressure: 0.7,
      shiftKey: true, relatedTarget: document.documentElement });
    expect(fixture.onPointerExit).toHaveBeenCalledOnce();
    expect(fixture.onPointerExit).toHaveBeenLastCalledWith(expect.objectContaining({
      pointerId: 7, pointerType: "mouse", clientX: rawX, clientY: 380, buttons: 1,
    }));
    expect(fixture.calls).toEqual(["exit"]);
    expect(fixture.captured.has(7)).toBe(true);
    fixture.runFrames(2);
    expect(fixture.cameraRef.current.x).toBeLessThan(10);
    expect(fixture.calls.slice(0, 3)).toEqual(["exit", "camera", "refresh"]);
    expect(fixture.onCameraMoved).toHaveBeenLastCalledWith(expect.objectContaining({
      pointerId: 7, clientX: rawX, clientY: 380, buttons: 1, pressure: 0.7, shiftKey: true,
    }));
  });

  it("does not latch on a DOM sibling inside the viewport even if it lies past the SVG boundary", () => {
    fixture.setup();
    fixture.pointer("pointermove", { clientX: 520, buttons: 1 });
    const sibling = document.createElement("div");
    document.body.append(sibling);
    fixture.hit = sibling;
    fixture.pointer("pointerout", { clientX: window.innerWidth - 1, buttons: 1, relatedTarget: sibling });
    fixture.runFrames();
    expect(fixture.onPointerExit).not.toHaveBeenCalled();
    expect(fixture.updateCamera).not.toHaveBeenCalled();
    expect(fixture.frames.size).toBe(0);
  });

  it("stops an outside drag if active pointer capture is unexpectedly lost", () => {
    fixture.setup();
    fixture.pointer("pointermove", { buttons: 1 });
    fixture.captured.add(7);
    leave({ buttons: 1 });
    fixture.runFrames();
    fixture.captured.delete(7);
    fixture.pointer("lostpointercapture", { buttons: 1 });
    const stoppedAt = fixture.cameraRef.current.x;
    fixture.pointer("pointerup");
    fixture.runFrames();
    expect(fixture.cameraRef.current.x).toBe(stoppedAt);
    expect(fixture.frames.size).toBe(0);
  });

  it.each(["touch", "pen"])("does not preserve outside scrolling after %s input", (pointerType) => {
    fixture.setup();
    fixture.pointer();
    leave();
    fixture.runFrames();
    fixture.pointer("pointerdown", { pointerType, pointerId: 12, buttons: 1 });
    const stoppedAt = fixture.cameraRef.current.x;
    fixture.runFrames();
    expect(fixture.cameraRef.current.x).toBe(stoppedAt);
    expect(fixture.frames.size).toBe(0);
  });

  it("ignores a foreign pointer release or lostcapture while the outside mouse keeps moving the view", () => {
    fixture.setup();
    fixture.pointer();
    leave();
    fixture.runFrames();
    fixture.pointer("pointerup", { pointerId: 18 });
    fixture.pointer("lostpointercapture", { pointerId: 18, buttons: 1 });
    fixture.pointer("pointerout", { pointerId: 18, clientX: 19, relatedTarget: null });
    const before = fixture.cameraRef.current.x;
    fixture.runFrames();
    expect(fixture.cameraRef.current.x).toBeLessThan(before);
    expect(fixture.onCameraMoved).not.toHaveBeenCalled();
  });

  it("does not arm outside scrolling from movement originating on another UI surface", () => {
    fixture.setup();
    fixture.pointer("pointermove", { clientX: 520 });
    const panel = document.createElement("button");
    document.body.append(panel);
    fixture.hit = null;
    fixture.pointer("pointermove", { clientX: 1450 }, panel);
    fixture.runFrames();
    expect(fixture.updateCamera).not.toHaveBeenCalled();
    expect(fixture.frames.size).toBe(0);
  });

  it("does not turn hovering a UI overlay into outside continuation", () => {
    fixture.setup();
    fixture.pointer();
    fixture.runFrames();
    const panel = document.createElement("button");
    document.body.append(panel);
    fixture.hit = panel;
    fixture.pointer("pointermove", {}, panel);
    const stoppedAt = fixture.cameraRef.current.x;
    leave({}, panel);
    fixture.runFrames();
    expect(fixture.cameraRef.current.x).toBe(stoppedAt);
    expect(fixture.frames.size).toBe(0);
  });

  it.each(["a", "button"])("does not start outside scrolling from a %s control inside SVG", (tag) => {
    fixture.setup();
    fixture.pointer("pointermove", { clientX: 520 });
    const content = document.createElementNS("http://www.w3.org/2000/svg", "foreignObject");
    const control = document.createElement(tag);
    if (tag === "a") control.setAttribute("href", "https://example.org");
    const label = document.createElement("span");
    control.append(label);
    content.append(control);
    fixture.svg.append(content);
    leave({}, label);
    fixture.runFrames();
    expect(fixture.updateCamera).not.toHaveBeenCalled();
    expect(fixture.frames.size).toBe(0);
  });

  it("clears outside continuation when the mouse returns over a panel inside the canvas rectangle", () => {
    fixture.setup();
    fixture.pointer();
    leave();
    fixture.runFrames();
    const panel = document.createElement("button");
    document.body.append(panel);
    fixture.hit = panel;
    fixture.pointer("pointermove", {}, panel);
    const stoppedAt = fixture.cameraRef.current.x;
    fixture.runFrames();
    expect(fixture.cameraRef.current.x).toBe(stoppedAt);
    fixture.hit = null;
    fixture.runFrames();
    expect(fixture.cameraRef.current.x).toBe(stoppedAt);
  });
});
