import { describe, expect, it } from "vitest";
import * as Y from "yjs";

import { offsetLayers, parseClipboardLayers, serializeLayers } from "@/lib/board/clipboard";
import { createGraphSettings } from "@/lib/board/graph/model";
import { BoardDocument } from "@/lib/collaboration/document";
import { LayerType } from "@/types/board-canvas";
import type { GraphLayer, GraphViewport } from "@/types/board-canvas";

function graphFixture(): GraphLayer {
  return {
    type: LayerType.Graph, x: 100, y: 80, width: 640, height: 480,
    graph: {
      ...createGraphSettings(),
      expressions: {
        curve_a: { formula: "y = x^2", color: "#2563eb", visible: true, order: 0 },
        curve_b: { formula: "y <= 2x + 1", color: "#16a34a", visible: true, order: 1 },
      },
      viewport: { xMin: -8, xMax: 8, yMin: -6, yMax: 6 },
      showGrid: true,
    },
  };
}

function graphWithRows(count: number): GraphLayer {
  const layer = graphFixture();
  for (let index = 2; index < count; index += 1) {
    layer.graph.expressions[`extra_${index}`] = {
      formula: `y = x + ${index}`, color: "#16a34a", visible: true, order: index,
    };
  }
  return layer;
}

function graphLayer(board: BoardDocument, id: string): GraphLayer {
  const layer = board.getLayer(id);
  if (layer?.type !== LayerType.Graph) throw new Error("Expected graph layer");
  return layer;
}

function sync(source: BoardDocument, target: BoardDocument): void {
  Y.applyUpdate(target.doc, Y.encodeStateAsUpdate(source.doc), "remote");
}

function withPeers(run: (first: BoardDocument, second: BoardDocument, id: string) => void, input = graphFixture()): void {
  const first = new BoardDocument();
  const second = new BoardDocument();
  try {
    const [id] = first.insert([input]);
    sync(first, second);
    run(first, second, id);
  } finally { first.destroy(); second.destroy(); }
}

describe("graph document persistence", () => {
  it("preserves editable formulas and math coordinates through clipboard, paste and native restore", () => {
    const source = new BoardDocument();
    const destination = new BoardDocument();
    const restored = new BoardDocument();
    try {
      const input = graphFixture();
      input.graph.expressions.curve_b.formula = "x >= sin(y)";
      const [sourceId] = source.insert([input]);
      const clipboard = parseClipboardLayers(serializeLayers([graphLayer(source, sourceId)]));
      expect(clipboard).toEqual([input]);
      const shifted = offsetLayers(clipboard!, 400, 300);
      const [copyId] = destination.insert(shifted);
      const copied = graphLayer(destination, copyId);
      expect(copied).toMatchObject({ x: 400, y: 300, width: 640, height: 480 });
      expect(copied.graph).toEqual(input.graph);
      sync(destination, restored);
      expect(graphLayer(restored, copyId)).toEqual(copied);
      destination.updateGraphExpression(copyId, "curve_a", { formula: "y =" });
      expect(graphLayer(destination, copyId).graph.expressions.curve_a.formula).toBe("y =");
      expect(graphLayer(source, sourceId).graph.expressions.curve_a.formula).toBe("y = x^2");
      sync(destination, restored);
      expect(graphLayer(restored, copyId)).toEqual(graphLayer(destination, copyId));
    } finally { source.destroy(); destination.destroy(); restored.destroy(); }
  });

  it("does not retain mutable references from inserted graphs or settings patches", () => {
    const board = new BoardDocument();
    try {
      const input = graphFixture();
      const expected = structuredClone(input);
      const [id] = board.insert([input]);
      input.graph.expressions.curve_a.formula = "changed outside the document";
      input.graph.viewport.xMin = -999;
      expect(graphLayer(board, id)).toEqual(expected);
      const viewport: GraphViewport = { xMin: -10, xMax: 10, yMin: -4, yMax: 4 };
      board.updateGraphSettings(id, { viewport });
      viewport.xMin = -999;
      expect(graphLayer(board, id).graph.viewport).toEqual({ xMin: -10, xMax: 10, yMin: -4, yMax: 4 });
    } finally { board.destroy(); }
  });

  it("rejects a generic settings replacement so ordinary updates cannot erase collaborative rows", () => {
    const board = new BoardDocument();
    try {
      const [id] = board.insert([graphFixture()]);
      const before = graphLayer(board, id);
      const replacement = graphFixture().graph;
      replacement.expressions.curve_a.formula = "y = 99";
      board.update([id], { graph: replacement });
      expect(graphLayer(board, id)).toEqual(before);
      board.update([id], { width: 800 });
      expect(graphLayer(board, id)).toMatchObject({ width: 800, graph: before.graph });
    } finally { board.destroy(); }
  });
});

describe("collaborative graph expressions", () => {
  it("retains every row when two peers independently fill the last interactive slot", () => {
    const input = graphWithRows(11);
    withPeers((first, second, id) => {
      const firstRow = first.addGraphExpression(id, { formula: "y = cos(x)", color: "#dc2626" });
      const secondRow = second.addGraphExpression(id, { formula: "x > 2", color: "#9333ea" });
      expect(firstRow).toBeTruthy();
      expect(secondRow).toBeTruthy();
      expect(Object.keys(graphLayer(first, id).graph.expressions)).toHaveLength(12);
      expect(Object.keys(graphLayer(second, id).graph.expressions)).toHaveLength(12);
      sync(first, second);
      sync(second, first);
      const merged = graphLayer(first, id);
      expect(Object.keys(merged.graph.expressions)).toHaveLength(13);
      expect(merged.graph.expressions).toMatchObject(input.graph.expressions);
      expect(merged.graph.expressions[firstRow!]).toMatchObject({ formula: "y = cos(x)", color: "#dc2626" });
      expect(merged.graph.expressions[secondRow!]).toMatchObject({ formula: "x > 2", color: "#9333ea" });
      expect(graphLayer(second, id)).toEqual(merged);
      expect(parseClipboardLayers(serializeLayers([merged]))).toEqual([merged]);
      first.updateGraphExpression(id, firstRow!, { visible: false });
      sync(first, second);
      expect(graphLayer(second, id).graph.expressions[firstRow!].visible).toBe(false);
      expect(Object.keys(graphLayer(second, id).graph.expressions)).toHaveLength(13);
    }, input);
  });

  it("keeps a graph valid when undo restores a deleted row after a peer fills its slot", () => {
    const input = graphWithRows(12);
    withPeers((first, second, id) => {
      first.removeGraphExpression(id, "curve_a");
      sync(first, second);
      const addedRow = second.addGraphExpression(id, { formula: "y = cos(x)", color: "#dc2626" });
      expect(addedRow).toBeTruthy();
      sync(second, first);
      expect(Object.keys(graphLayer(first, id).graph.expressions)).toHaveLength(12);
      expect(graphLayer(first, id).graph.expressions).not.toHaveProperty("curve_a");
      first.undo();
      const restored = graphLayer(first, id);
      expect(Object.keys(restored.graph.expressions)).toHaveLength(13);
      expect(restored.graph.expressions).toMatchObject(input.graph.expressions);
      expect(restored.graph.expressions[addedRow!]).toMatchObject({ formula: "y = cos(x)", color: "#dc2626" });
      sync(first, second);
      expect(graphLayer(second, id)).toEqual(restored);
      first.redo();
      expect(Object.keys(graphLayer(first, id).graph.expressions)).toHaveLength(12);
      expect(graphLayer(first, id).graph.expressions).not.toHaveProperty("curve_a");
      expect(graphLayer(first, id).graph.expressions[addedRow!].formula).toBe("y = cos(x)");
      sync(first, second);
      expect(graphLayer(second, id)).toEqual(graphLayer(first, id));
    }, input);
  });

  it("merges simultaneous changes to different expression rows", () => {
    withPeers((first, second, id) => {
      first.updateGraphExpression(id, "curve_a", { formula: "y = 2x + 1" });
      second.updateGraphExpression(id, "curve_b", { formula: "x >= y^2", visible: false });
      sync(first, second);
      sync(second, first);
      expect(graphLayer(first, id).graph.expressions).toEqual({
        curve_a: { formula: "y = 2x + 1", color: "#2563eb", visible: true, order: 0 },
        curve_b: { formula: "x >= y^2", color: "#16a34a", visible: false, order: 1 },
      });
      expect(graphLayer(second, id)).toEqual(graphLayer(first, id));
    });
  });

  it("merges formula and color edits within the same row without replacing that row", () => {
    withPeers((first, second, id) => {
      first.updateGraphExpression(id, "curve_a", { formula: "y = sin(x)" });
      second.updateGraphExpression(id, "curve_a", { color: "#dc2626", visible: false });
      sync(second, first);
      sync(first, second);
      expect(graphLayer(first, id).graph.expressions.curve_a).toEqual({
        formula: "y = sin(x)", color: "#dc2626", visible: false, order: 0,
      });
      expect(graphLayer(second, id)).toEqual(graphLayer(first, id));
    });
  });

  it("keeps independently added expressions and does not recreate a removed row", () => {
    withPeers((first, second, id) => {
      const firstRow = first.addGraphExpression(id, { formula: "y = cos(x)", color: "#dc2626" });
      const secondRow = second.addGraphExpression(id, { formula: "x > 2", color: "#9333ea" });
      expect(firstRow).toBeTruthy();
      expect(secondRow).toBeTruthy();
      expect(firstRow).not.toBe(secondRow);
      sync(first, second);
      sync(second, first);
      const expressions = graphLayer(first, id).graph.expressions;
      expect(Object.keys(expressions)).toHaveLength(4);
      expect(expressions[firstRow!]).toMatchObject({ formula: "y = cos(x)", color: "#dc2626" });
      expect(expressions[secondRow!]).toMatchObject({ formula: "x > 2", color: "#9333ea" });
      expect(graphLayer(second, id)).toEqual(graphLayer(first, id));
      second.removeGraphExpression(id, firstRow!);
      first.updateGraphExpression(id, firstRow!, { formula: "y = 100" });
      sync(first, second);
      sync(second, first);
      expect(graphLayer(first, id).graph.expressions).not.toHaveProperty(firstRow!);
      expect(graphLayer(second, id)).toEqual(graphLayer(first, id));
      first.updateGraphExpression(id, firstRow!, { visible: true });
      expect(graphLayer(first, id).graph.expressions).not.toHaveProperty(firstRow!);
    });
  });

  it("undoes a local formula edit while retaining another author's color and other formula", () => {
    withPeers((first, second, id) => {
      first.updateGraphExpression(id, "curve_a", { formula: "y = sin(x)" });
      second.updateGraphExpression(id, "curve_a", { color: "#dc2626" });
      second.updateGraphExpression(id, "curve_b", { formula: "y > x" });
      sync(second, first);
      first.undo();
      expect(graphLayer(first, id).graph.expressions.curve_a).toMatchObject({
        formula: "y = x^2", color: "#dc2626",
      });
      expect(graphLayer(first, id).graph.expressions.curve_b.formula).toBe("y > x");
      first.redo();
      expect(graphLayer(first, id).graph.expressions.curve_a).toMatchObject({
        formula: "y = sin(x)", color: "#dc2626",
      });
      sync(first, second);
      expect(graphLayer(second, id)).toEqual(graphLayer(first, id));
    });
  });

  it("records a resize atomically and preserves remote expressions and settings on undo", () => {
    withPeers((first, second, id) => {
      const original = graphLayer(first, id);
      let updates = 0;
      first.doc.on("update", () => { updates += 1; });
      first.resizeGraph(id, { x: original.x, y: original.y, width: 960, height: original.height });
      expect(updates).toBe(1);
      expect(graphLayer(first, id).graph.viewport).toEqual({ xMin: -8, xMax: 16, yMin: -6, yMax: 6 });
      second.updateGraphExpression(id, "curve_b", { formula: "x >= sin(y)" });
      second.updateGraphSettings(id, { showGrid: false });
      sync(second, first);
      first.undo();
      expect(graphLayer(first, id)).toMatchObject({
        x: original.x, y: original.y, width: original.width, height: original.height,
        graph: { viewport: original.graph.viewport, showGrid: false, expressions: { curve_b: { formula: "x >= sin(y)" } } },
      });
      first.redo();
      expect(graphLayer(first, id)).toMatchObject({
        x: original.x, y: original.y, width: 960, height: original.height,
        graph: { viewport: { xMin: -8, xMax: 16, yMin: -6, yMax: 6 },
          showGrid: false, expressions: { curve_b: { formula: "x >= sin(y)" } } },
      });
      sync(first, second);
      expect(graphLayer(second, id)).toEqual(graphLayer(first, id));
    });
  });

  it("merges a viewport update and grid toggle while keeping expression changes", () => {
    withPeers((first, second, id) => {
      const viewport = { xMin: -10, xMax: 10, yMin: -4, yMax: 4 };
      first.updateGraphSettings(id, { viewport });
      second.updateGraphSettings(id, { showGrid: false });
      second.updateGraphExpression(id, "curve_a", { formula: "y = abs(x)" });
      sync(first, second);
      sync(second, first);
      expect(graphLayer(first, id).graph).toMatchObject({
        viewport, showGrid: false, expressions: { curve_a: { formula: "y = abs(x)" } },
      });
      expect(graphLayer(second, id)).toEqual(graphLayer(first, id));
    });
  });

  it("does not permit graph mutations or undo in viewer mode", () => {
    const board = new BoardDocument();
    try {
      const [id] = board.insert([graphFixture()]);
      board.setWritable(false);
      const before = Y.encodeStateAsUpdate(board.doc);
      expect(board.addGraphExpression(id, { formula: "y = 99" })).toBeNull();
      board.updateGraphExpression(id, "curve_a", { formula: "y = 99" });
      board.removeGraphExpression(id, "curve_b");
      board.updateGraphSettings(id, { showGrid: false });
      board.update([id], { width: 900 });
      board.resizeGraph(id, { x: 100, y: 80, width: 900, height: 480 });
      board.undo();
      expect(Y.encodeStateAsUpdate(board.doc)).toEqual(before);
    } finally { board.destroy(); }
  });

  it("does not recreate a graph deleted by a peer when a stale editor commits", () => {
    withPeers((first, second, id) => {
      second.remove([id]);
      sync(second, first);
      expect(first.addGraphExpression(id, { formula: "y = 99" })).toBeNull();
      first.updateGraphExpression(id, "curve_a", { formula: "y = 99" });
      first.removeGraphExpression(id, "curve_b");
      first.updateGraphSettings(id, { showGrid: false });
      first.update([id], { width: 900 });
      first.resizeGraph(id, { x: 100, y: 80, width: 900, height: 480 });
      expect(first.getLayer(id)).toBeUndefined();
      expect(first.getSnapshot().layerIds).toEqual([]);
      sync(first, second);
      expect(second.getLayer(id)).toBeUndefined();
    });
  });
});
