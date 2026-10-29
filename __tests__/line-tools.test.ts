import { describe, expect, it } from "vitest";
import * as Y from "yjs";

import { offsetLayers, parseClipboardLayers, serializeLayers } from "@/lib/board/clipboard";
import { intersectsViewport } from "@/lib/board/geometry";
import { clipLineToBounds, createLine, distanceToLine, lineArrowPoints, lineBounds, lineEndpoints, snapLineEnd } from "@/lib/board/line";
import { parseLayer } from "@/lib/board/model";
import { BoardDocument } from "@/lib/collaboration/document";
import { pickLayersInBox } from "@/lib/utils";
import { LayerType } from "@/types/board-canvas";
import type { LineLayer, Point } from "@/types/board-canvas";

const black = { r: 0, g: 0, b: 0 };
const sync = (source: BoardDocument, target: BoardDocument): void => {
  Y.applyUpdate(target.doc, Y.encodeStateAsUpdate(source.doc), "remote");
};

describe("line layer compatibility and validation", () => {
  it("keeps persisted legacy layer type values unchanged", () => {
    expect([LayerType.Rectangle, LayerType.Ellipse, LayerType.Text, LayerType.Sticker, LayerType.Path, LayerType.Image])
      .toEqual([0, 1, 2, 3, 4, 5]);
    expect(LayerType.LinkPreview).toBe("linkPreview");
    expect(LayerType.Line).toBe(6);
  });

  it.each<[Point, Point]>([
    [{ x: 10, y: 20 }, { x: 90, y: 100 }],
    [{ x: 90, y: 20 }, { x: 10, y: 100 }],
    [{ x: 10, y: 100 }, { x: 90, y: 20 }],
    [{ x: 90, y: 100 }, { x: 10, y: 20 }],
    [{ x: 10, y: 20 }, { x: 90, y: 20 }],
    [{ x: 90, y: 20 }, { x: 10, y: 20 }],
    [{ x: 10, y: 20 }, { x: 10, y: 100 }],
    [{ x: 10, y: 100 }, { x: 10, y: 20 }],
  ])("preserves endpoint identity in every direction, including zero width or height: %j → %j", (start, end) => {
    const layer = createLine(start, end, black);
    expect(layer.width).toBeGreaterThanOrEqual(0);
    expect(layer.height).toBeGreaterThanOrEqual(0);
    expect(lineEndpoints(layer)).toEqual([start, end]);
    expect(parseLayer(layer)).toEqual(layer);
  });

  it("rejects malformed endpoints, arrow flags, kinds, widths and degenerate lines", () => {
    const line = createLine({ x: 0, y: 0 }, { x: 100, y: 100 }, black);
    for (const patch of [
      { start: undefined }, { start: { x: -1, y: 0 } }, { end: { x: 2, y: 1 } },
      { end: { x: NaN, y: 1 } }, { end: { x: 1, y: Infinity } }, { start: [0, 0] },
      { lineKind: "ray" }, { lineKind: undefined }, { startArrow: "true" }, { endArrow: 1 },
      { startArrow: undefined }, { endArrow: undefined }, { strokeWidth: 0 }, { strokeWidth: 21 },
      { strokeWidth: Infinity }, { strokeWidth: undefined }, { fill: undefined },
      { width: 0, height: 0 }, { start: { x: 1, y: 1 } },
    ]) expect(parseLayer({ ...line, ...patch }), JSON.stringify(patch)).toBeNull();
  });

  it("copies mutable endpoint and color inputs before storing them", () => {
    const input = createLine({ x: 10, y: 20 }, { x: 90, y: 100 }, black);
    const parsed = parseLayer(input) as LineLayer;
    input.start.x = 1;
    input.fill.r = 255;
    expect(lineEndpoints(parsed)).toEqual([{ x: 10, y: 20 }, { x: 90, y: 100 }]);
    expect(parsed.fill).toEqual({ ...black, a: 1 });
  });
});

describe("infinite line geometry", () => {
  it("clips a straight line to the viewport even when both control points are far outside", () => {
    const line = createLine({ x: -10_000, y: -10_000 }, { x: -9_000, y: -9_000 }, black, "line");
    const viewport = { x: 0, y: 0, width: 200, height: 100 };
    expect(clipLineToBounds(line, viewport)).toEqual([{ x: 0, y: 0 }, { x: 100, y: 100 }]);
    expect(clipLineToBounds({ ...line, lineKind: "segment" }, viewport)).toBeNull();
    expect(intersectsViewport(line, { x: 0, y: 0, scale: 1 }, viewport)).toBe(true);
    const outside = createLine({ x: 10_000, y: -100 }, { x: 10_000, y: 100 }, black, "line");
    expect(intersectsViewport(outside, { x: 0, y: 0, scale: 1 }, viewport)).toBe(false);
  });

  it("handles horizontal, vertical, reverse and corner-touching intersections", () => {
    const bounds = { x: 0, y: 0, width: 100, height: 100 };
    const make = (start: Point, end: Point): LineLayer => createLine(start, end, black, "line");
    expect(clipLineToBounds(make({ x: 50, y: 50 }, { x: 40, y: 50 }), bounds))
      .toEqual([{ x: 100, y: 50 }, { x: 0, y: 50 }]);
    expect(clipLineToBounds(make({ x: 40, y: -10 }, { x: 40, y: -5 }), bounds))
      .toEqual([{ x: 40, y: 0 }, { x: 40, y: 100 }]);
    expect(clipLineToBounds(make({ x: -20, y: 20 }, { x: -10, y: 10 }), bounds))
      .toEqual([{ x: 0, y: 0 }, { x: 0, y: 0 }]);
    expect(clipLineToBounds(make({ x: 10, y: -1 }, { x: 20, y: -1 }), bounds)).toBeNull();
  });

  it("selects the visible continuation of a straight line while keeping segment hitbox selection", () => {
    const infinite = createLine({ x: -1000, y: -1000 }, { x: -900, y: -900 }, black, "line");
    const segment = createLine({ x: 0, y: 0 }, { x: 100, y: 100 }, black);
    const layers = new Map<string, LineLayer>([["infinite", infinite], ["segment", segment]]);
    expect(pickLayersInBox(["infinite"], layers, { x: 40, y: 40 }, { x: 60, y: 60 })).toEqual(["infinite"]);
    expect(pickLayersInBox(["infinite", "segment"], layers, { x: 10, y: 80 }, { x: 20, y: 90 }))
      .toEqual(["segment"]);
  });

  it("distinguishes the stroke from empty space in its bounding box and from segment extensions", () => {
    const segment = createLine({ x: 0, y: 0 }, { x: 100, y: 100 }, black);
    expect(distanceToLine({ x: 0, y: 100 }, segment)).toBeGreaterThan(70);
    expect(distanceToLine({ x: 500, y: 500 }, segment)).toBeGreaterThan(500);
    expect(distanceToLine({ x: 500, y: 500 }, { ...segment, lineKind: "line" })).toBe(0);
    expect(distanceToLine({ x: 50, y: 53 }, segment)).toBeCloseTo(3 / Math.sqrt(2));
  });

  it("snaps Shift endpoints to horizontal, vertical and diagonal directions", () => {
    const origin = { x: 10, y: 20 };
    expect(snapLineEnd(origin, { x: 100, y: 25 }).y).toBe(20);
    expect(snapLineEnd(origin, { x: 15, y: 100 }).x).toBe(10);
    const diagonal = snapLineEnd(origin, { x: -90, y: -100 });
    expect(diagonal.x - origin.x).toBeCloseTo(diagonal.y - origin.y);
    expect(diagonal.x).toBeLessThan(origin.x);
  });

  it("keeps arrow tips on their endpoint and fits short arrowheads inside the segment", () => {
    const tip = { x: 0, y: 0 };
    const points = lineArrowPoints(tip, { x: 4, y: 0 }, 8).split(" ").map((point) => point.split(",").map(Number));
    expect(points[0]).toEqual([0, 0]);
    expect(points[1][0]).toBeGreaterThan(0);
    expect(points[1][0]).toBeLessThan(2);
    expect(points[1][1]).toBeGreaterThan(0);
    expect(points[2][1]).toBeLessThan(0);
    expect(points.flat().every(Number.isFinite)).toBe(true);
  });
});

describe("line persistence, clipboard and collaborative undo", () => {
  it("round-trips reversed arrows through clipboard, offsets and saved Yjs state", () => {
    const line = { ...createLine({ x: 100, y: 100 }, { x: 20, y: 100 }, black), startArrow: true, endArrow: true };
    const copied = parseClipboardLayers(serializeLayers([line]));
    expect(copied).toEqual([line]);
    const shifted = offsetLayers(copied!, 200, 300) as LineLayer[];
    expect(lineEndpoints(shifted[0])).toEqual([{ x: 280, y: 300 }, { x: 200, y: 300 }]);
    const first = new BoardDocument();
    const second = new BoardDocument();
    try {
      const [id] = first.insert(shifted);
      sync(first, second);
      expect(second.getLayer(id)).toEqual(shifted[0]);
      expect(second.getLayer(id)).toMatchObject({ startArrow: true, endArrow: true, height: 0 });
    } finally { first.destroy(); second.destroy(); }
  });

  it("undoes all endpoint fields atomically without losing a peer's color or arrows", () => {
    const first = new BoardDocument();
    const second = new BoardDocument();
    try {
      const initial = createLine({ x: 0, y: 0 }, { x: 100, y: 0 }, black);
      const [id] = first.insert([initial]);
      sync(first, second);
      let updates = 0;
      first.doc.on("update", () => { updates += 1; });
      first.update([id], lineBounds({ x: 150, y: 40 }, { x: 100, y: 0 }));
      expect(updates).toBe(1);
      second.update([id], { fill: { r: 20, g: 80, b: 220 }, endArrow: true });
      sync(second, first);
      first.undo();
      expect(lineEndpoints(first.getLayer(id) as LineLayer)).toEqual([{ x: 0, y: 0 }, { x: 100, y: 0 }]);
      expect(first.getLayer(id)).toMatchObject({ fill: { r: 20, g: 80, b: 220 }, endArrow: true });
      first.redo();
      expect(lineEndpoints(first.getLayer(id) as LineLayer)).toEqual([{ x: 150, y: 40 }, { x: 100, y: 0 }]);
      sync(first, second);
      expect(second.getLayer(id)).toEqual(first.getLayer(id));
    } finally { first.destroy(); second.destroy(); }
  });
});
