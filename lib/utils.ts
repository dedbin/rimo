import { Camera, Color, Point, side, XYWH, Layer } from "@/types/board-canvas"
import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

const COLORS = ["#DC2626", "#D97706", "#059669", "#3B82F6", "#8B5CF6", "#F472B6"]
const MIN_WIDTH  = 40;  
const MIN_HEIGHT = 20; 
const GOLDEN_ANGLE = 137.508;  

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

function hslToHex(h: number, s: number, l: number): string {
  l /= 100;
  const a = s * Math.min(l, 1 - l) / 100;
  const f = (n: number) => {
    const k = (n + h / 30) % 12;
    const color = l - a * Math.max(Math.min(k - 3, 9 - k, 1), -1);
    return Math.round(255 * color).toString(16).padStart(2, "0");
  };
  return `#${f(0)}${f(8)}${f(4)}`;
}

export function connectionIdToColor(id: number): string {            
  const hue = (id * GOLDEN_ANGLE) % 360;     
  const saturation = 65;                     
  const lightness = 55;                      
  return hslToHex(hue, saturation, lightness);
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

export function resizeBounds(
  orig: XYWH,
  corner: side,
  point: Point
): XYWH {
  const result: XYWH = { ...orig };

  if (corner & side.left) {
    result.x      = Math.min(orig.x + orig.width, point.x);
    result.width  = Math.abs(orig.x + orig.width - point.x);
  }
  if (corner & side.right) {
    result.x      = Math.min(orig.x, point.x);
    result.width  = Math.abs(orig.x - point.x);
  }
  if (corner & side.top) {
    result.y       = Math.min(orig.y + orig.height, point.y);
    result.height  = Math.abs(orig.y + orig.height - point.y);
  }
  if (corner & side.bottom) {
    result.y       = Math.min(orig.y, point.y);
    result.height  = Math.abs(orig.y - point.y);
  }

  if (result.width < MIN_WIDTH) {
    if (corner & side.left) {
      result.x = orig.x + orig.width - MIN_WIDTH;
    }
    result.width = MIN_WIDTH;
  }
  if (result.height < MIN_HEIGHT) {
    if (corner & side.top) {
      result.y = orig.y + orig.height - MIN_HEIGHT;
    }
    result.height = MIN_HEIGHT;
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

export function getContrastingTextColor(color: Color) {
    const luminance = 0.299 * color.r + 0.587 * color.g + 0.114 * color.b; // Luminance formula
    return luminance > 182 ? "black" : "white";
}

export function measureText(text: string, fontSize: number): number {
  const ctx = document.createElement("canvas").getContext("2d")!;
  ctx.font = `${fontSize}px Poppins`;
  return ctx.measureText(text).width;
}