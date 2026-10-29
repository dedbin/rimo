import { LayerType } from "../../types/board-canvas";
import type { Layer, XYWH } from "../../types/board-canvas";
import { clipLineToBounds } from "./line";

export interface BoardFrame extends XYWH { readonly name: string }

export const MAX_FRAMES = 200;
export const MAX_FRAME_NAME = 120;
export const FRAME_ROOT = "frames";
export const FRAME_ORDER_ROOT = "frameIds";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) &&
    [Object.prototype, null].includes(Object.getPrototypeOf(value));
}

export function parseFrame(value: unknown): BoardFrame | null {
  if (!isRecord(value) || !["name", "x", "y", "width", "height"].every((key) => Object.hasOwn(value, key))) return null;
  const { name, x, y, width, height } = value;
  if (typeof name !== "string" || !name.trim() || name.length > MAX_FRAME_NAME || /[\u0000-\u001f]/.test(name)) return null;
  if (![x, y, width, height].every((item) => typeof item === "number" && Number.isFinite(item) && Math.abs(item) <= 10_000_000)) return null;
  if ((width as number) < 1 || (height as number) < 1) return null;
  return { name: name.trim(), x: x as number, y: y as number, width: width as number, height: height as number };
}

export function normalizeFrameOrder(ids: readonly string[], frames: ReadonlyMap<string, BoardFrame>): readonly string[] {
  const seen = new Set<string>();
  const result = ids.filter((id) => {
    if (!frames.has(id) || seen.has(id)) return false;
    seen.add(id);
    return true;
  });
  for (const id of [...frames.keys()].sort()) if (!seen.has(id)) result.push(id);
  return result;
}

export function visualBounds(layer: Layer): XYWH {
  const padding = layer.type === LayerType.Path ? (layer.size ?? 16)
    : layer.type === LayerType.Line && layer.lineKind === "segment" && (layer.startArrow || layer.endArrow)
      ? Math.max(10, layer.strokeWidth * 4)
      : "strokeWidth" in layer ? (layer.strokeWidth ?? 0) / 2 : 0;
  return { x: layer.x - padding, y: layer.y - padding, width: Math.max(1, layer.width) + padding * 2, height: Math.max(1, layer.height) + padding * 2 };
}

export function layerIntersectsBounds(layer: Layer, bounds: XYWH): boolean {
  if (layer.type !== LayerType.Line || layer.lineKind !== "line") return intersectsBounds(visualBounds(layer), bounds);
  const padding = layer.strokeWidth / 2;
  return clipLineToBounds(layer, { x: bounds.x - padding, y: bounds.y - padding,
    width: bounds.width + padding * 2, height: bounds.height + padding * 2 }) !== null;
}

export function boundsForLayers(layers: readonly Layer[], padding = 12): XYWH | null {
  if (!layers.length) return null;
  const bounds = layers.map(visualBounds);
  const x = Math.min(...bounds.map((item) => item.x)) - padding;
  const y = Math.min(...bounds.map((item) => item.y)) - padding;
  const right = Math.max(...bounds.map((item) => item.x + item.width)) + padding;
  const bottom = Math.max(...bounds.map((item) => item.y + item.height)) + padding;
  return { x, y, width: Math.max(1, right - x), height: Math.max(1, bottom - y) };
}

export function intersectsBounds(first: XYWH, second: XYWH): boolean {
  return first.x + first.width > second.x && second.x + second.width > first.x &&
    first.y + first.height > second.y && second.y + second.height > first.y;
}

export function containsBounds(outer: XYWH, inner: XYWH): boolean {
  return inner.x >= outer.x && inner.y >= outer.y &&
    inner.x + inner.width <= outer.x + outer.width && inner.y + inner.height <= outer.y + outer.height;
}
