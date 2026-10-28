import { describe, expect, it } from "vitest";
import { pickLayersInBox } from "@/lib/utils";
import { Layer, LayerType, Point } from "@/types/board-canvas";

const rectangle: Layer = {
  type: LayerType.Rectangle, x: 10, y: 10, width: 20, height: 20,
  fill: { r: 0, g: 0, b: 0, a: 0 },
};

function pick(from: Point, to: Point, layer: Layer = rectangle): string[] {
  return pickLayersInBox(["shape"], new Map([["shape", layer]]), from, to);
}

describe("selection box hitbox intersection", () => {
  it.each([
    [{ x: 0, y: 0 }, { x: 15, y: 15 }],
    [{ x: 15, y: 15 }, { x: 0, y: 0 }],
    [{ x: 0, y: 15 }, { x: 15, y: 0 }],
    [{ x: 15, y: 0 }, { x: 0, y: 15 }],
  ])("selects a partially overlapped hitbox in drag direction %#", (from, to) => {
    expect(pick(from, to)).toEqual(["shape"]);
  });

  it.each([
    [{ x: 15, y: 15 }, { x: 25, y: 25 }],
    [{ x: 0, y: 15 }, { x: 40, y: 25 }],
    [{ x: 15, y: 0 }, { x: 25, y: 40 }],
  ])("selects a containing or crossed hitbox without enclosed corners %#", (from, to) => {
    expect(pick(from, to)).toEqual(["shape"]);
  });

  it.each([
    [{ x: 0, y: 15 }, { x: 10, y: 25 }],
    [{ x: 30, y: 15 }, { x: 40, y: 25 }],
    [{ x: 15, y: 0 }, { x: 25, y: 10 }],
    [{ x: 15, y: 30 }, { x: 25, y: 40 }],
    [{ x: 0, y: 0 }, { x: 10, y: 10 }],
  ])("selects a hitbox when only its edge or corner is touched %#", (from, to) => {
    expect(pick(from, to)).toEqual(["shape"]);
  });

  it.each([
    [{ x: 0, y: 15 }, { x: 9.99, y: 25 }],
    [{ x: 30.01, y: 15 }, { x: 40, y: 25 }],
    [{ x: 15, y: 0 }, { x: 25, y: 9.99 }],
    [{ x: 15, y: 30.01 }, { x: 25, y: 40 }],
  ])("does not select a separated hitbox %#", (from, to) => {
    expect(pick(from, to)).toEqual([]);
  });

  it.each([
    { width: 20, height: 0, points: [[0, 0], [20, 0]] },
    { width: 0, height: 20, points: [[0, 0], [0, 20]] },
  ])("selects a partially crossed path with bounds $width by $height", (bounds) => {
    const path: Layer = { ...rectangle, type: LayerType.Path, ...bounds };
    expect(pick({ x: 0, y: 0 }, { x: 15, y: 15 }, path)).toEqual(["shape"]);
  });

  it("keeps layer order while skipping missing and separated objects", () => {
    const layers = new Map<string, Layer>([
      ["rectangle", rectangle],
      ["ellipse", { ...rectangle, type: LayerType.Ellipse }],
      ["outside", { ...rectangle, x: 50 }],
    ]);
    expect(pickLayersInBox(["ellipse", "missing", "outside", "rectangle"], layers,
      { x: 0, y: 0 }, { x: 15, y: 15 })).toEqual(["ellipse", "rectangle"]);
  });
});
