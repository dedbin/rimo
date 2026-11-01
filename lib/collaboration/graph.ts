import { nanoid } from "nanoid";
import * as Y from "yjs";

import { LayerType } from "../../types/board-canvas";
import type { GraphExpression, GraphSettings, XYWH } from "../../types/board-canvas";
import { MAX_GRAPH_EXPRESSIONS, parseGraphSettings } from "../board/graph/model";
import { resizeGraphViewport } from "../board/graph/resize";
import { parseLayer } from "../board/model";
import type { BoardDocument } from "./document";

const COLORS = ["#2563eb", "#e11d48", "#059669", "#9333ea", "#d97706", "#0891b2"];

export function graphToYMap(graph: GraphSettings): Y.Map<unknown> {
  const expressions = new Y.Map<Y.Map<unknown>>();
  for (const [id, expression] of Object.entries(graph.expressions)) {
    expressions.set(id, new Y.Map(Object.entries(expression)));
  }
  return new Y.Map<unknown>([
    ["expressions", expressions], ["viewport", { ...graph.viewport }], ["showGrid", graph.showGrid],
  ]);
}

function graphMap(board: BoardDocument, id: string): Y.Map<unknown> | null {
  const layer = board.layers.get(id);
  if (!(layer instanceof Y.Map) || layer.get("type") !== LayerType.Graph) return null;
  const graph = layer.get("graph");
  if (graph instanceof Y.Map) return graph;
  const checked = parseGraphSettings(graph);
  if (!checked) return null;
  const converted = graphToYMap(checked);
  layer.set("graph", converted);
  return converted;
}

function checkedSettings(board: BoardDocument, id: string): GraphSettings | null {
  const layer = board.getLayer(id);
  return layer?.type === LayerType.Graph ? layer.graph : null;
}

export function addGraphExpression(board: BoardDocument, id: string, input: Partial<GraphExpression> = {}): string | null {
  const current = checkedSettings(board, id);
  if (!board.canEdit || !current || Object.keys(current.expressions).length >= MAX_GRAPH_EXPRESSIONS) return null;
  const entries = Object.values(current.expressions);
  const expression: GraphExpression = { formula: "", color: COLORS[entries.length % COLORS.length],
    visible: true, order: Math.max(-1, ...entries.map((entry) => entry.order)) + 1, ...input };
  const expressionId = nanoid();
  const checked = parseGraphSettings({ ...current, expressions: { ...current.expressions, [expressionId]: expression } });
  if (!checked) return null;
  let added = false;
  board.transact(() => {
    const graph = graphMap(board, id);
    const expressions = graph?.get("expressions");
    if (!(expressions instanceof Y.Map)) return;
    expressions.set(expressionId, new Y.Map(Object.entries(checked.expressions[expressionId])));
    added = true;
  });
  return added ? expressionId : null;
}

export function updateGraphExpression(board: BoardDocument, id: string, expressionId: string, patch: Partial<GraphExpression>): void {
  const current = checkedSettings(board, id);
  if (!board.canEdit || !current || !Object.hasOwn(current.expressions, expressionId)) return;
  const checked = parseGraphSettings({ ...current,
    expressions: { ...current.expressions, [expressionId]: { ...current.expressions[expressionId], ...patch } } });
  if (!checked) return;
  board.transact(() => {
    const expressions = graphMap(board, id)?.get("expressions");
    const row = expressions instanceof Y.Map ? expressions.get(expressionId) : null;
    if (!(row instanceof Y.Map)) return;
    for (const key of ["formula", "color", "visible", "order"] as const) {
      if (Object.hasOwn(patch, key)) row.set(key, checked.expressions[expressionId][key]);
    }
  });
}

export function removeGraphExpression(board: BoardDocument, id: string, expressionId: string): void {
  if (!board.canEdit || !checkedSettings(board, id)) return;
  board.transact(() => {
    const expressions = graphMap(board, id)?.get("expressions");
    if (expressions instanceof Y.Map) expressions.delete(expressionId);
  });
}

export function updateGraphSettings(board: BoardDocument, id: string, patch: Partial<Pick<GraphSettings, "viewport" | "showGrid">>): void {
  const current = checkedSettings(board, id);
  if (!board.canEdit || !current) return;
  const checked = parseGraphSettings({ ...current, ...patch });
  if (!checked) return;
  board.transact(() => {
    const graph = graphMap(board, id);
    if (!graph) return;
    if (Object.hasOwn(patch, "viewport")) graph.set("viewport", checked.viewport);
    if (Object.hasOwn(patch, "showGrid")) graph.set("showGrid", checked.showGrid);
  });
}

export function resizeGraph(board: BoardDocument, id: string, bounds: XYWH): void {
  const current = board.getLayer(id);
  if (!board.canEdit || current?.type !== LayerType.Graph) return;
  const viewport = resizeGraphViewport(current, current.graph.viewport, bounds);
  const checked = parseLayer({ ...current, ...bounds, graph: { ...current.graph, viewport } });
  if (checked?.type !== LayerType.Graph) return;
  board.transact(() => {
    const graph = graphMap(board, id);
    const layer = board.layers.get(id);
    if (!graph || !(layer instanceof Y.Map)) return;
    for (const key of ["x", "y", "width", "height"] as const) layer.set(key, checked[key]);
    graph.set("viewport", checked.graph.viewport);
  });
}
