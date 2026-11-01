import { side } from "../../../types/board-canvas";
import type { GraphViewport, Point, XYWH } from "../../../types/board-canvas";

export const MIN_GRAPH_WIDTH = 160;
export const MIN_GRAPH_HEIGHT = 120;

export function resizeGraphBounds(initial: XYWH, handle: side, point: Point): XYWH {
  if (![initial.x, initial.y, initial.width, initial.height, point.x, point.y].every(Number.isFinite)) return { ...initial };
  const left = Boolean(handle & side.left);
  const right = Boolean(handle & side.right);
  const top = Boolean(handle & side.top);
  const bottom = Boolean(handle & side.bottom);
  const anchorX = left ? initial.x + initial.width : initial.x;
  const anchorY = top ? initial.y + initial.height : initial.y;
  const horizontal = left || right;
  const vertical = top || bottom;
  let width = horizontal ? Math.max(MIN_GRAPH_WIDTH, left ? anchorX - point.x : point.x - anchorX) : initial.width;
  let height = vertical ? Math.max(MIN_GRAPH_HEIGHT, top ? anchorY - point.y : point.y - anchorY) : initial.height;
  if (horizontal && vertical && initial.width > 0 && initial.height > 0) {
    // Project the pointer onto the original diagonal while keeping the far corner fixed.
    const dx = left ? anchorX - point.x : point.x - anchorX;
    const dy = top ? anchorY - point.y : point.y - anchorY;
    const scale = Math.max(MIN_GRAPH_WIDTH / initial.width, MIN_GRAPH_HEIGHT / initial.height,
      (dx * initial.width + dy * initial.height) / (initial.width ** 2 + initial.height ** 2));
    width = initial.width * scale;
    height = initial.height * scale;
  }
  return { x: left ? anchorX - width : initial.x, y: top ? anchorY - height : initial.y, width, height };
}

export function resizeGraphViewport(initial: XYWH, viewport: GraphViewport, next: XYWH): GraphViewport {
  const scaleX = next.width / initial.width;
  const scaleY = next.height / initial.height;
  if (![scaleX, scaleY].every(Number.isFinite) || Math.abs(scaleX - scaleY) < 1e-8) return { ...viewport };
  const spanX = viewport.xMax - viewport.xMin;
  const spanY = viewport.yMax - viewport.yMin;
  const result = { ...viewport };
  if (Math.abs(scaleX - 1) > 1e-8) {
    if (Math.abs(next.x - initial.x) > 1e-8) result.xMin = viewport.xMax - spanX * scaleX;
    else result.xMax = viewport.xMin + spanX * scaleX;
  }
  if (Math.abs(scaleY - 1) > 1e-8) {
    if (Math.abs(next.y - initial.y) > 1e-8) result.yMax = viewport.yMin + spanY * scaleY;
    else result.yMin = viewport.yMax - spanY * scaleY;
  }
  return result;
}
