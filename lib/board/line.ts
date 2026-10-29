import { LayerType } from "../../types/board-canvas";
import type { Color, LineKind, LineLayer, Point, XYWH } from "../../types/board-canvas";

export function lineEndpoints(layer: LineLayer): readonly [Point, Point] {
  return [layer.start, layer.end].map((point) => ({
    x: layer.x + point.x * layer.width, y: layer.y + point.y * layer.height,
  })) as [Point, Point];
}

export function lineBounds(start: Point, end: Point): Pick<LineLayer, "x" | "y" | "width" | "height" | "start" | "end"> {
  const x = Math.min(start.x, end.x);
  const y = Math.min(start.y, end.y);
  const width = Math.abs(end.x - start.x);
  const height = Math.abs(end.y - start.y);
  const relative = (point: Point): Point => ({ x: width ? (point.x - x) / width : 0, y: height ? (point.y - y) / height : 0 });
  return { x, y, width, height, start: relative(start), end: relative(end) };
}

export function createLine(start: Point, end: Point, color: Color, lineKind: LineKind = "segment"): LineLayer {
  return { type: LayerType.Line, ...lineBounds(start, end), fill: { ...color, a: 1 },
    strokeWidth: 2, lineKind, startArrow: false, endArrow: false };
}

export function snapLineEnd(origin: Point, point: Point): Point {
  const dx = point.x - origin.x;
  const dy = point.y - origin.y;
  const angle = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * Math.PI / 4;
  const length = Math.hypot(dx, dy);
  // Round trig noise so a horizontal/vertical segment has exactly zero height/width.
  return { x: origin.x + Math.round(Math.cos(angle) * length * 1e8) / 1e8,
    y: origin.y + Math.round(Math.sin(angle) * length * 1e8) / 1e8 };
}

export function clipLineToBounds(layer: LineLayer, bounds: XYWH): readonly [Point, Point] | null {
  const [start, end] = lineEndpoints(layer);
  const direction = { x: end.x - start.x, y: end.y - start.y };
  if (direction.x === 0 && direction.y === 0) return null;
  let from = layer.lineKind === "line" ? -Infinity : 0;
  let to = layer.lineKind === "line" ? Infinity : 1;
  for (const axis of ["x", "y"] as const) {
    const min = bounds[axis];
    const max = min + (axis === "x" ? bounds.width : bounds.height);
    if (direction[axis] === 0) {
      if (start[axis] < min || start[axis] > max) return null;
    } else {
      const first = (min - start[axis]) / direction[axis];
      const second = (max - start[axis]) / direction[axis];
      from = Math.max(from, Math.min(first, second));
      to = Math.min(to, Math.max(first, second));
      if (from > to) return null;
    }
  }
  return [{ x: start.x + direction.x * from, y: start.y + direction.y * from },
    { x: start.x + direction.x * to, y: start.y + direction.y * to }];
}

export function distanceToLine(point: Point, layer: LineLayer): number {
  const [start, end] = lineEndpoints(layer);
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const lengthSquared = dx * dx + dy * dy;
  if (!lengthSquared) return Math.hypot(point.x - start.x, point.y - start.y);
  const projection = ((point.x - start.x) * dx + (point.y - start.y) * dy) / lengthSquared;
  const ratio = layer.lineKind === "line" ? projection : Math.min(1, Math.max(0, projection));
  return Math.hypot(point.x - start.x - ratio * dx, point.y - start.y - ratio * dy);
}

export function lineArrowPoints(tip: Point, toward: Point, strokeWidth: number): string {
  const length = Math.hypot(toward.x - tip.x, toward.y - tip.y);
  if (!length) return `${tip.x},${tip.y}`;
  const size = Math.min(Math.max(10, strokeWidth * 4), length * 0.45);
  const dx = (toward.x - tip.x) / length;
  const dy = (toward.y - tip.y) / length;
  const base = { x: tip.x + dx * size, y: tip.y + dy * size };
  return `${tip.x},${tip.y} ${base.x - dy * size * 0.45},${base.y + dx * size * 0.45} ${base.x + dy * size * 0.45},${base.y - dx * size * 0.45}`;
}
