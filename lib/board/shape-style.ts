import { LayerType } from "@/types/board-canvas";
import type { Color, EllipseLayer, Layer, RectangleLayer } from "@/types/board-canvas";

export type ShapeLayer = RectangleLayer | EllipseLayer;
export type Paint = Color | null;

export function isShape(layer: Layer | undefined): layer is ShapeLayer {
  return layer?.type === LayerType.Rectangle || layer?.type === LayerType.Ellipse;
}

export function shapeStroke(layer: ShapeLayer): Paint {
  return layer.stroke && (layer.stroke.a ?? 1) > 0 && (layer.strokeWidth ?? 0) > 0 ? layer.stroke : null;
}

export function samePaint(first: Paint, second: Paint): boolean {
  if (first === null || second === null) return first === second;
  return first.r === second.r && first.g === second.g && first.b === second.b && (first.a ?? 1) === (second.a ?? 1);
}

export function shapeFillPatch(layer: ShapeLayer, fill: Paint): Partial<ShapeLayer> {
  if (fill) return { fill: { ...fill } };
  return {
    fill: { ...layer.fill, a: 0 },
    ...(!shapeStroke(layer) ? { stroke: { ...layer.fill, a: 1 }, strokeWidth: 2 } : {}),
  };
}
