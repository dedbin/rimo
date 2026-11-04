import { cleanup } from "@testing-library/react";
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

function beginCapturedExit(): number {
  fixture.onPointerExit.mockImplementation((sample) => { fixture.captured.add(sample.pointerId); });
  fixture.setup();
  fixture.pointer("pointermove", { clientX: 520, buttons: 1 });
  fixture.hit = null;
  const clientX = window.innerWidth + 100;
  fixture.pointer("pointerout", { clientX, buttons: 1, pressure: 0.7,
    relatedTarget: document.documentElement });
  fixture.runFrames(2);
  return clientX;
}

describe("outside auto-pan during native capture transfer", () => {
  it("keeps a captured outside drag running through the document-element to SVG pointerout", () => {
    const rawX = beginCapturedExit();
    expect(fixture.captured.has(7)).toBe(true);
    expect(fixture.cameraRef.current.x).toBeLessThan(10);
    const before = fixture.cameraRef.current.x;
    const refreshed = fixture.onCameraMoved.mock.calls.length;
    fixture.pointer("pointerout", { clientX: rawX, buttons: 1, pressure: 0.7,
      relatedTarget: fixture.svg }, document.documentElement);
    fixture.runFrames();
    expect(fixture.cameraRef.current.x).toBeLessThan(before);
    expect(fixture.onCameraMoved.mock.calls.length).toBeGreaterThan(refreshed);
    expect(fixture.onCameraMoved).toHaveBeenLastCalledWith(expect.objectContaining({
      pointerId: 7, pointerType: "mouse", clientX: rawX, clientY: 380, buttons: 1, pressure: 0.7,
    }));
    expect(fixture.onPointerExit).toHaveBeenCalledOnce();
  });

  it("keeps stationary outside hover after release and the SVG-to-HTML-to-null pointerout sequence", () => {
    const rawX = beginCapturedExit();
    expect(fixture.cameraRef.current.x).toBeLessThan(10);
    fixture.pointer("pointerup", { clientX: rawX });
    fixture.captured.delete(7);
    fixture.pointer("lostpointercapture", { clientX: rawX });
    fixture.pointer("pointerout", { clientX: rawX, relatedTarget: document.documentElement });
    fixture.pointer("pointerout", { clientX: rawX, relatedTarget: null }, document.documentElement);
    const releasedAt = fixture.cameraRef.current.x;
    const refreshed = fixture.onCameraMoved.mock.calls.length;
    fixture.runFrames();
    expect(fixture.cameraRef.current.x).toBeLessThan(releasedAt);
    const first = fixture.cameraRef.current.x;
    fixture.runFrames();
    expect(fixture.cameraRef.current.x).toBeLessThan(first);
    expect(fixture.onCameraMoved).toHaveBeenCalledTimes(refreshed);
    expect(fixture.onPointerExit).toHaveBeenCalledOnce();
  });
});
