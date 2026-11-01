import { describe, expect, it } from "vitest";

import { resizeGraphBounds, resizeGraphViewport } from "@/lib/board/graph/resize";
import { side } from "@/types/board-canvas";
import type { GraphViewport, Point, XYWH } from "@/types/board-canvas";

const initial: XYWH = { x: 100, y: 200, width: 640, height: 480 };
const viewport: GraphViewport = { xMin: -8, xMax: 8, yMin: -6, yMax: 6 };

interface CornerCase { readonly handle: side; readonly point: Point; readonly opposite: Point }

const corners: readonly CornerCase[] = [
  { handle: side.top | side.left, point: { x: -220, y: -100 }, opposite: { x: 740, y: 680 } },
  { handle: side.top | side.right, point: { x: 1060, y: -100 }, opposite: { x: 100, y: 680 } },
  { handle: side.bottom | side.left, point: { x: -220, y: 980 }, opposite: { x: 740, y: 200 } },
  { handle: side.bottom | side.right, point: { x: 1060, y: 980 }, opposite: { x: 100, y: 200 } },
];

function fixedCorner(bounds: XYWH, handle: side): Point {
  return {
    x: handle & side.left ? bounds.x + bounds.width : bounds.x,
    y: handle & side.top ? bounds.y + bounds.height : bounds.y,
  };
}

describe("graph rectangle resizing", () => {
  it.each(corners)("keeps the aspect ratio and opposite corner for handle $handle", ({ handle, point, opposite }) => {
    const next = resizeGraphBounds(initial, handle, point);
    expect(next.width / next.height).toBeCloseTo(initial.width / initial.height, 10);
    expect(next.width).toBeGreaterThan(initial.width);
    expect(next.height).toBeGreaterThan(initial.height);
    expect(fixedCorner(next, handle)).toEqual(opposite);
  });

  it.each([
    { handle: side.left, point: { x: -220, y: 900 }, expected: { x: -220, y: 200, width: 960, height: 480 } },
    { handle: side.right, point: { x: 1060, y: 900 }, expected: { x: 100, y: 200, width: 960, height: 480 } },
    { handle: side.top, point: { x: 900, y: -40 }, expected: { x: 100, y: -40, width: 640, height: 720 } },
    { handle: side.bottom, point: { x: 900, y: 920 }, expected: { x: 100, y: 200, width: 640, height: 720 } },
  ])("changes only one dimension when dragging side $handle", ({ handle, point, expected }) => {
    expect(resizeGraphBounds(initial, handle, point)).toEqual(expected);
  });

  it.each([
    { handle: side.left, point: { x: 1000, y: 0 }, expected: { x: 580, y: 200, width: 160, height: 480 } },
    { handle: side.right, point: { x: -500, y: 0 }, expected: { x: 100, y: 200, width: 160, height: 480 } },
    { handle: side.top, point: { x: 0, y: 1200 }, expected: { x: 100, y: 560, width: 640, height: 120 } },
    { handle: side.bottom, point: { x: 0, y: -500 }, expected: { x: 100, y: 200, width: 640, height: 120 } },
  ])("clamps side $handle at the minimum instead of flipping across its opposite edge", ({ handle, point, expected }) => {
    expect(resizeGraphBounds(initial, handle, point)).toEqual(expected);
  });

  it.each([
    { handle: side.top | side.left, point: { x: 1200, y: 1200 }, opposite: { x: 740, y: 680 } },
    { handle: side.top | side.right, point: { x: -300, y: 1200 }, opposite: { x: 100, y: 680 } },
    { handle: side.bottom | side.left, point: { x: 1200, y: -300 }, opposite: { x: 740, y: 200 } },
    { handle: side.bottom | side.right, point: { x: -300, y: -300 }, opposite: { x: 100, y: 200 } },
  ])("clamps corner $handle without losing its ratio or opposite anchor", ({ handle, point, opposite }) => {
    const next = resizeGraphBounds(initial, handle, point);
    expect(next.width).toBe(160);
    expect(next.height).toBe(120);
    expect(fixedCorner(next, handle)).toEqual(opposite);
  });

  it("satisfies both minimum dimensions when a wide graph is resized proportionally", () => {
    const wide = { x: 20, y: 30, width: 800, height: 300 };
    const next = resizeGraphBounds(wide, side.right | side.bottom, { x: -100, y: -100 });
    expect(next).toEqual({ x: 20, y: 30, width: 320, height: 120 });
    expect(next.width / next.height).toBeCloseTo(wide.width / wide.height, 10);
  });

  it("does not mutate the original rectangle or pointer", () => {
    const bounds = Object.freeze({ ...initial });
    const point = Object.freeze({ x: 1000, y: 900 });
    const next = resizeGraphBounds(bounds, side.right | side.bottom, point);
    expect(bounds).toEqual(initial);
    expect(point).toEqual({ x: 1000, y: 900 });
    expect(next).not.toBe(bounds);
  });
});

describe("graph coordinate viewport during resize", () => {
  it.each(corners)("keeps the mathematical range during proportional corner $handle scaling", ({ handle, point }) => {
    const next = resizeGraphBounds(initial, handle, point);
    expect(resizeGraphViewport(initial, viewport, next)).toEqual(viewport);
  });

  it.each([
    { handle: side.right, point: { x: 1060, y: 0 }, expected: { xMin: -8, xMax: 16, yMin: -6, yMax: 6 } },
    { handle: side.left, point: { x: -220, y: 0 }, expected: { xMin: -16, xMax: 8, yMin: -6, yMax: 6 } },
    { handle: side.top, point: { x: 0, y: -40 }, expected: { xMin: -8, xMax: 8, yMin: -6, yMax: 12 } },
    { handle: side.bottom, point: { x: 0, y: 920 }, expected: { xMin: -8, xMax: 8, yMin: -12, yMax: 6 } },
  ])("reveals coordinates from side $handle while preserving square units", ({ handle, point, expected }) => {
    const bounds = resizeGraphBounds(initial, handle, point);
    const next = resizeGraphViewport(initial, viewport, bounds);
    expect(next).toEqual(expected);
    const pixelsPerXUnit = bounds.width / (next.xMax - next.xMin);
    const pixelsPerYUnit = bounds.height / (next.yMax - next.yMin);
    expect(pixelsPerXUnit).toBeCloseTo(40, 10);
    expect(pixelsPerYUnit).toBeCloseTo(pixelsPerXUnit, 10);
  });

  it("narrows the visible range around the opposite horizontal edge", () => {
    const right = resizeGraphBounds(initial, side.right, { x: 420, y: 0 });
    const left = resizeGraphBounds(initial, side.left, { x: 420, y: 0 });
    expect(resizeGraphViewport(initial, viewport, right)).toEqual({ xMin: -8, xMax: 0, yMin: -6, yMax: 6 });
    expect(resizeGraphViewport(initial, viewport, left)).toEqual({ xMin: 0, xMax: 8, yMin: -6, yMax: 6 });
  });

  it("leaves the mathematical viewport unchanged for a pure move", () => {
    expect(resizeGraphViewport(initial, viewport, { ...initial, x: -500, y: 700 })).toEqual(viewport);
  });

  it("does not mutate input coordinates when changing the displayed range", () => {
    const frozen = Object.freeze({ ...viewport });
    const next = resizeGraphViewport(initial, frozen, { ...initial, width: 960 });
    expect(frozen).toEqual(viewport);
    expect(next).toEqual({ xMin: -8, xMax: 16, yMin: -6, yMax: 6 });
  });
});
