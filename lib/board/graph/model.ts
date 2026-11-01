import type { GraphExpression, GraphSettings, GraphViewport } from "../../../types/board-canvas";

export const MAX_GRAPH_EXPRESSIONS = 12;
// Concurrent additions can exceed the interactive limit before peers synchronize.
// Keep those rows editable; rendering remains capped at MAX_GRAPH_EXPRESSIONS.
export const MAX_STORED_GRAPH_EXPRESSIONS = 256;
export const MAX_GRAPH_FORMULA_LENGTH = 256;
export const MIN_GRAPH_SPAN = 0.0001;
export const MAX_GRAPH_SPAN = 1_000_000;
export const GRAPH_COLORS = ["#2563eb", "#dc2626", "#059669", "#9333ea", "#d97706", "#0891b2"] as const;

function record(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function own(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return keys.every((key) => Object.hasOwn(value, key));
}

export function parseGraphViewport(value: unknown): GraphViewport | null {
  if (!record(value) || !own(value, ["xMin", "xMax", "yMin", "yMax"])) return null;
  const { xMin, xMax, yMin, yMax } = value;
  if (![xMin, xMax, yMin, yMax].every((item) => typeof item === "number" &&
    Number.isFinite(item) && Math.abs(item) <= MAX_GRAPH_SPAN)) return null;
  const viewport = { xMin, xMax, yMin, yMax } as GraphViewport;
  const spans = [viewport.xMax - viewport.xMin, viewport.yMax - viewport.yMin];
  return spans.every((span) => span >= MIN_GRAPH_SPAN && span <= MAX_GRAPH_SPAN) ? viewport : null;
}

export function parseGraphExpression(value: unknown): GraphExpression | null {
  if (!record(value) || !own(value, ["formula", "color", "visible", "order"])) return null;
  if (typeof value.formula !== "string" || value.formula.length > MAX_GRAPH_FORMULA_LENGTH ||
    typeof value.color !== "string" || !/^#[0-9a-fA-F]{6}$/.test(value.color) ||
    typeof value.visible !== "boolean" || typeof value.order !== "number" ||
    !Number.isFinite(value.order) || Math.abs(value.order) > MAX_GRAPH_SPAN) return null;
  return { formula: value.formula, color: value.color, visible: value.visible, order: value.order };
}

export function parseGraphSettings(value: unknown): GraphSettings | null {
  if (!record(value) || !own(value, ["expressions", "viewport", "showGrid"]) ||
    !record(value.expressions) || typeof value.showGrid !== "boolean") return null;
  const viewport = parseGraphViewport(value.viewport);
  if (!viewport) return null;
  const entries = Object.entries(value.expressions);
  if (entries.length > MAX_STORED_GRAPH_EXPRESSIONS) return null;
  const expressions: [string, GraphExpression][] = [];
  for (const [id, input] of entries) {
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(id) || ["__proto__", "prototype", "constructor"].includes(id)) return null;
    const expression = parseGraphExpression(input);
    if (!expression) return null;
    expressions.push([id, expression]);
  }
  return { expressions: Object.fromEntries(expressions), viewport, showGrid: value.showGrid };
}

export function createGraphSettings(): GraphSettings {
  return {
    expressions: {
      parabola: { formula: "y = x^2", color: GRAPH_COLORS[0], visible: true, order: 0 },
      line: { formula: "y = 2x + 1", color: GRAPH_COLORS[1], visible: true, order: 1 },
    },
    viewport: { xMin: -8, xMax: 8, yMin: -5.5, yMax: 5.5 },
    showGrid: true,
  };
}

export function sortedGraphExpressions(graph: GraphSettings): [string, GraphExpression][] {
  return Object.entries(graph.expressions).sort(([leftId, left], [rightId, right]) =>
    left.order - right.order || (leftId < rightId ? -1 : leftId > rightId ? 1 : 0));
}
