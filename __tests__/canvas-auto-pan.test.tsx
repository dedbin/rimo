import { act, cleanup } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AutoPanFixture } from "./auto-pan-fixture";

let fixture: AutoPanFixture;

beforeEach(() => { fixture = new AutoPanFixture(); });
afterEach(() => {
  cleanup();
  fixture.restore();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("canvas edge auto-pan lifecycle", () => {
  it("keeps moving a stationary hovering mouse and refreshes its board position after the camera", () => {
    fixture.setup();
    fixture.pointer();
    fixture.runFrames();
    const first = fixture.cameraRef.current.x;
    expect(first).toBeLessThan(10);
    fixture.runFrames();
    expect(fixture.cameraRef.current.x).toBeLessThan(first);
    expect(fixture.cameraRef.current).toMatchObject({ y: 20, scale: 2 });
    expect(fixture.calls.length).toBeGreaterThan(0);
    expect(fixture.calls.every((call, index) => call === (index % 2 ? "refresh" : "camera"))).toBe(true);
    expect(fixture.refreshedCameras.at(-1)).toEqual(fixture.cameraRef.current);
    expect(fixture.onCameraMoved).toHaveBeenLastCalledWith(expect.objectContaining({
      pointerId: 7, pointerType: "mouse", clientX: 1010, clientY: 380, buttons: 0,
    }));
  });

  it("captures mouse movement even when a child stops propagation without consuming the event", () => {
    fixture.body.addEventListener("pointermove", (event) => event.stopPropagation());
    fixture.setup();
    const event = fixture.pointer();
    fixture.runFrames();
    expect(fixture.cameraRef.current.x).toBeLessThan(10);
    expect(event.defaultPrevented).toBe(false);
  });

  it("stops in the center and does not leave an idle animation loop", () => {
    fixture.setup();
    fixture.pointer();
    fixture.runFrames();
    fixture.pointer("pointermove", { clientX: 520 });
    fixture.runFrames();
    const count = fixture.updateCamera.mock.calls.length;
    fixture.runFrames();
    expect(fixture.updateCamera).toHaveBeenCalledTimes(count);
    expect(fixture.frames.size).toBe(0);
  });

  it("continues hover after pointerup and its expected lostpointercapture", () => {
    fixture.setup();
    fixture.pointer("pointermove", { buttons: 1, pressure: 0.5 });
    fixture.runFrames();
    fixture.pointer("pointerup");
    fixture.pointer("lostpointercapture");
    const releasedAt = fixture.cameraRef.current.x;
    fixture.runFrames();
    expect(fixture.cameraRef.current.x).toBeLessThan(releasedAt);
    expect(fixture.onCameraMoved).toHaveBeenLastCalledWith(expect.objectContaining({ buttons: 0 }));
  });

  it("pauses an unstarted click and resumes hover when the button is released", () => {
    fixture.setup();
    fixture.pointer();
    fixture.canPan.mockReturnValue(false);
    fixture.pointer("pointerdown", { buttons: 1 });
    fixture.runFrames();
    expect(fixture.updateCamera).not.toHaveBeenCalled();
    fixture.canPan.mockReturnValue(true);
    fixture.pointer("pointerup");
    fixture.runFrames();
    expect(fixture.cameraRef.current.x).toBeLessThan(10);
  });

  it("ignores a lostcapture retargeted from a child while the SVG still owns the pointer", () => {
    fixture.setup();
    fixture.pointer("pointermove", { buttons: 1 });
    fixture.captured.add(7);
    fixture.pointer("lostpointercapture", { buttons: 1 });
    fixture.runFrames();
    expect(fixture.cameraRef.current.x).toBeLessThan(10);
  });

  it("clears on unexpected loss of an active mouse capture", () => {
    fixture.setup();
    fixture.pointer("pointermove", { buttons: 1 });
    fixture.runFrames();
    fixture.pointer("lostpointercapture", { buttons: 1 });
    const stoppedAt = fixture.cameraRef.current.x;
    fixture.pointer("pointerup");
    fixture.runFrames();
    expect(fixture.cameraRef.current.x).toBe(stoppedAt);
    fixture.pointer();
    fixture.runFrames();
    expect(fixture.cameraRef.current.x).toBeLessThan(stoppedAt);
  });

  it.each(["disabled", "blocked"] as const)("clears the stored position when %s, requiring fresh movement", (reason) => {
    const { rerender } = fixture.setup();
    fixture.pointer();
    fixture.runFrames();
    rerender({ enabled: reason !== "disabled", blocked: reason === "blocked" });
    const stoppedAt = fixture.cameraRef.current.x;
    fixture.runFrames();
    rerender({ enabled: true, blocked: false });
    fixture.pointer("pointerup");
    fixture.runFrames();
    expect(fixture.cameraRef.current.x).toBe(stoppedAt);
    expect(fixture.frames.size).toBe(0);
    fixture.pointer();
    fixture.runFrames();
    expect(fixture.cameraRef.current.x).toBeLessThan(stoppedAt);
  });

  it("does not arm from mouseup or mousedown alone after an explicit reset", () => {
    const { result } = fixture.setup();
    fixture.pointer();
    fixture.runFrames();
    act(() => result.current.reset());
    const stoppedAt = fixture.cameraRef.current.x;
    fixture.pointer("pointerdown", { buttons: 1 });
    fixture.pointer("pointerup");
    fixture.runFrames();
    expect(fixture.cameraRef.current.x).toBe(stoppedAt);
    fixture.pointer();
    fixture.runFrames();
    expect(fixture.cameraRef.current.x).toBeLessThan(stoppedAt);
  });

  it.each(["touch", "pen"])("clears an old hovering mouse on %s input", (pointerType) => {
    fixture.setup();
    fixture.pointer();
    fixture.runFrames();
    fixture.pointer("pointerdown", { pointerId: 12, pointerType, buttons: 1 });
    const stoppedAt = fixture.cameraRef.current.x;
    fixture.pointer("pointermove", { pointerId: 12, pointerType, buttons: 1 });
    fixture.pointer("pointerup", { pointerId: 12, pointerType });
    fixture.runFrames();
    expect(fixture.cameraRef.current.x).toBe(stoppedAt);
    expect(fixture.frames.size).toBe(0);
    fixture.pointer();
    fixture.runFrames();
    expect(fixture.cameraRef.current.x).toBeLessThan(stoppedAt);
  });

  it.each([2, 4])("lets manual button navigation take over for buttons=%s", (buttons) => {
    fixture.setup();
    fixture.pointer();
    fixture.runFrames();
    fixture.pointer("pointerdown", { buttons });
    const stoppedAt = fixture.cameraRef.current.x;
    fixture.runFrames();
    expect(fixture.cameraRef.current.x).toBe(stoppedAt);
  });

  it("stops over a real overlay despite a captured SVG event target", () => {
    fixture.setup();
    fixture.pointer("pointermove", { buttons: 1 });
    fixture.runFrames();
    const panel = document.createElement("button");
    document.body.append(panel);
    fixture.hit = panel;
    const stoppedAt = fixture.cameraRef.current.x;
    fixture.runFrames();
    expect(fixture.cameraRef.current.x).toBe(stoppedAt);
    expect(fixture.frames.size).toBe(0);
    fixture.hit = fixture.body;
    fixture.runFrames();
    expect(fixture.cameraRef.current.x).toBe(stoppedAt);
  });

  it.each(["data-graph-interaction", "contenteditable"])("does not scroll through SVG descendants marked %s", (attribute) => {
    fixture.setup();
    fixture.body.setAttribute(attribute, "true");
    fixture.pointer();
    fixture.runFrames();
    expect(fixture.updateCamera).not.toHaveBeenCalled();
  });

  it("stops when a text input gains focus without moving a parked mouse", () => {
    fixture.setup();
    fixture.pointer();
    fixture.runFrames();
    const input = document.createElement("input");
    document.body.append(input);
    input.focus();
    const stoppedAt = fixture.cameraRef.current.x;
    fixture.runFrames();
    expect(fixture.cameraRef.current.x).toBe(stoppedAt);
  });

  it.each(["dialog", "alertdialog", "menu"])("stops while a %s is open even with the mouse behind it", (role) => {
    fixture.setup();
    fixture.pointer();
    fixture.runFrames();
    const popup = document.createElement("div");
    popup.setAttribute("role", role);
    popup.dataset.state = "open";
    document.body.append(popup);
    const stoppedAt = fixture.cameraRef.current.x;
    fixture.runFrames();
    expect(fixture.cameraRef.current.x).toBe(stoppedAt);
  });

  it("checks physical bounds after resize instead of scrolling a stale edge forever", () => {
    fixture.setup();
    fixture.pointer();
    fixture.runFrames();
    fixture.svg.getBoundingClientRect = (): DOMRect => new DOMRect(20, 30, 600, 700);
    const stoppedAt = fixture.cameraRef.current.x;
    fixture.runFrames();
    expect(fixture.cameraRef.current.x).toBe(stoppedAt);
    expect(fixture.frames.size).toBe(0);
  });

  it.each(["cancel", "blur", "escape", "wheel", "hidden", "leave"])("clears on %s until a fresh mousemove", (reason) => {
    fixture.setup();
    fixture.pointer();
    fixture.runFrames();
    act(() => {
      if (reason === "cancel") fixture.pointer("pointercancel");
      if (reason === "blur") window.dispatchEvent(new Event("blur"));
      if (reason === "escape") document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      if (reason === "wheel") fixture.svg.dispatchEvent(new WheelEvent("wheel", { deltaY: 40, bubbles: true }));
      if (reason === "hidden") {
        vi.spyOn(document, "hidden", "get").mockReturnValue(true);
        document.dispatchEvent(new Event("visibilitychange"));
      }
      if (reason === "leave") fixture.pointer("pointerout", { relatedTarget: null });
    });
    const stoppedAt = fixture.cameraRef.current.x;
    fixture.runFrames();
    expect(fixture.cameraRef.current.x).toBe(stoppedAt);
    expect(fixture.frames.size).toBe(0);
    if (reason === "hidden") vi.spyOn(document, "hidden", "get").mockReturnValue(false);
    fixture.pointer();
    fixture.runFrames();
    expect(fixture.cameraRef.current.x).toBeLessThan(stoppedAt);
  });

  it("keeps manual pan in control while Space is held and waits for fresh movement after release", () => {
    fixture.setup();
    fixture.pointer();
    fixture.runFrames();
    act(() => document.dispatchEvent(new KeyboardEvent("keydown", { code: "Space", key: " ", bubbles: true })));
    const stoppedAt = fixture.cameraRef.current.x;
    fixture.pointer();
    fixture.runFrames();
    expect(fixture.cameraRef.current.x).toBe(stoppedAt);
    act(() => document.dispatchEvent(new KeyboardEvent("keyup", { code: "Space", key: " ", bubbles: true })));
    fixture.runFrames();
    expect(fixture.cameraRef.current.x).toBe(stoppedAt);
    fixture.pointer();
    fixture.runFrames();
    expect(fixture.cameraRef.current.x).toBeLessThan(stoppedAt);
  });

  it("cancels pending frames and removes document listeners on unmount", () => {
    const { unmount } = fixture.setup();
    fixture.pointer();
    fixture.runFrames();
    unmount();
    const stoppedAt = fixture.cameraRef.current.x;
    expect(fixture.frames.size).toBe(0);
    fixture.pointer();
    fixture.runFrames();
    expect(fixture.cameraRef.current.x).toBe(stoppedAt);
    expect(fixture.frames.size).toBe(0);
  });
});
