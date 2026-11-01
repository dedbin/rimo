import type { GraphViewport } from "../../../types/board-canvas";
import { parseGraphViewport } from "./model";

/** Remove only floating-point noise near a short decimal, preserving meaningful precision. */
export function cleanGraphCoordinate(value: number): number {
  if (Object.is(value, -0)) return 0;
  const candidate = Number(value.toPrecision(12));
  return Math.abs(candidate - value) <= Math.abs(value) * Number.EPSILON * 8 ? candidate : value;
}

export function cleanGraphViewport(value: GraphViewport): GraphViewport | null {
  const original = parseGraphViewport(value);
  if (!original) return null;
  const cleaned = { xMin: cleanGraphCoordinate(original.xMin), xMax: cleanGraphCoordinate(original.xMax),
    yMin: cleanGraphCoordinate(original.yMin), yMax: cleanGraphCoordinate(original.yMax) };
  // Rounding must never make a valid narrow range invalid or collapse its endpoints.
  return parseGraphViewport(cleaned) ?? original;
}

export function stepGraphViewport(viewport: GraphViewport, factor: number): GraphViewport | null {
  const centerX = (viewport.xMin + viewport.xMax) / 2;
  const centerY = (viewport.yMin + viewport.yMax) / 2;
  const halfX = (viewport.xMax - viewport.xMin) * factor / 2;
  const halfY = (viewport.yMax - viewport.yMin) * factor / 2;
  return cleanGraphViewport({ xMin: centerX - halfX, xMax: centerX + halfX,
    yMin: centerY - halfY, yMax: centerY + halfY });
}
