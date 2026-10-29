import { Camera, Layer, LayerType, Point, XYWH } from "@/types/board-canvas";
import { clipLineToBounds } from "./line";

export function getBounds(layers: readonly Layer[]): XYWH | null {
  if (!layers.length) return null;
  let left = Infinity;
  let top = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;
  for (const layer of layers) {
    left = Math.min(left, layer.x);
    top = Math.min(top, layer.y);
    right = Math.max(right, layer.x + layer.width);
    bottom = Math.max(bottom, layer.y + layer.height);
  }
  return { x: left, y: top, width: right - left, height: bottom - top };
}

export function isInsideBounds(point: Point, bounds: XYWH): boolean {
  return point.x >= bounds.x && point.x <= bounds.x + bounds.width &&
    point.y >= bounds.y && point.y <= bounds.y + bounds.height;
}

export function intersectsViewport(layer: Layer, camera: Camera, viewport: { width: number; height: number }): boolean {
  const margin = 200 / camera.scale;
  const left = -camera.x / camera.scale - margin;
  const top = -camera.y / camera.scale - margin;
  if (layer.type === LayerType.Line && layer.lineKind === "line") {
    return clipLineToBounds(layer, { x: left, y: top, width: viewport.width / camera.scale + margin * 2,
      height: viewport.height / camera.scale + margin * 2 }) !== null;
  }
  return layer.x + layer.width >= left && layer.y + layer.height >= top &&
    layer.x <= left + viewport.width / camera.scale + margin * 2 &&
    layer.y <= top + viewport.height / camera.scale + margin * 2;
}
