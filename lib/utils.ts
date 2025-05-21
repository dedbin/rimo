import { Camera, Color, Point, side, XYWH, Layer } from "@/types/board-canvas"
import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

const COLORS = ["#DC2626", "#D97706", "#059669", "#3B82F6", "#8B5CF6", "#F472B6"]

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

// TODO: make in a better way
export function connectionIdToColor(connectionId: number): string {
  return COLORS[connectionId % COLORS.length]
}

export function pointerEventToCanvasPoint(
  e: React.PointerEvent,
  camera: Camera,
) {
  return {
    x: Math.round(e.clientX) - camera.x,
    y: Math.round(e.clientY) - camera.y,
  }
}

export function rgbToCss(color: Color) {
  const rgb = [color.r, color.g, color.b]
  const r = rgb[0].toString(16).padStart(2, "0")
  const g = rgb[1].toString(16).padStart(2, "0")
  const b = rgb[2].toString(16).padStart(2, "0")
  return `#${r}${g}${b}`
}


export function resizeBounds(bounds: XYWH, corner: side, point: Point): XYWH {
    const result = { ...bounds };

    if ((corner & side.left) === side.left) {
        result.x = Math.min(bounds.x + bounds.width, point.x);
        result.width = Math.abs(bounds.x + bounds.width - point.x);
    }

    if ((corner & side.right) === side.right) {
        result.x = Math.min(bounds.x, point.x);
        result.width = Math.abs(bounds.x - point.x);
    }

    if ((corner & side.top) === side.top) {
        result.y = Math.min(bounds.y + bounds.height, point.y);
        result.height = Math.abs(bounds.y + bounds.height - point.y);
    }

    if ((corner & side.bottom) === side.bottom) {
        result.y = Math.min(bounds.y, point.y);
        result.height = Math.abs(bounds.y - point.y);
    }

    return result;
}

function normalizeArea(p1: Point, p2: Point) {
  const left = Math.min(p1.x, p2.x);
  const right = Math.max(p1.x, p2.x);
  const top = Math.min(p1.y, p2.y);
  const bottom = Math.max(p1.y, p2.y);

  return { left, right, top, bottom };
}

export function pickLayersInBox(
  layerIds: readonly string[],
  layerMap: ReadonlyMap<string, Layer>,
  corner1: Point,
  corner2: Point
): string[] {
  const box = normalizeArea(corner1, corner2);

  return layerIds.filter((id) => {
    const layer = layerMap.get(id);
    if (!layer) return false;

    const layerLeft = layer.x;
    const layerRight = layer.x + layer.width;
    const layerTop = layer.y;
    const layerBottom = layer.y + layer.height;

    
    return (
      box.left <= layerLeft &&
      box.right >= layerRight &&
      box.top <= layerTop &&
      box.bottom >= layerBottom
    );
  });
}