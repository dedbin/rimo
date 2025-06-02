import { Camera, Color, Point, side, XYWH, Layer, LayerType, PathLayer } from "@/types/board-canvas"
import { LiveObject } from "@liveblocks/client";
import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

const MIN_WIDTH  = 40;  
const MIN_HEIGHT = 20; 
const GOLDEN_ANGLE = 137.508;  
const PATH_ERASE_TOLERANCE = 12;

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
  clientX: number,
  clientY: number,
  camera: Camera,
  svg: SVGSVGElement
): Point {
  const rect = svg.getBoundingClientRect();
  const x = (clientX - rect.left - camera.x) / camera.scale;
  const y = (clientY - rect.top - camera.y) / camera.scale;
  return { x, y };
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

export function makePathLayer(points: number[][], fillColor: Color, size: number): PathLayer {
    if (points.length < 2) {
    throw new Error("At least two points are required to build a path");
  }

  const { minX, minY, maxX, maxY } = points.reduce(
    (acc, [x, y]) => ({
      minX: x < acc.minX ? x : acc.minX,
      minY: y < acc.minY ? y : acc.minY,
      maxX: x > acc.maxX ? x : acc.maxX,
      maxY: y > acc.maxY ? y : acc.maxY,
    }),
    {
      minX: Infinity,
      minY: Infinity,
      maxX: -Infinity,
      maxY: -Infinity,
    }
  );

  const offsetPoints = points.map(([x, y, pressure]) => [
    x - minX,
    y - minY,
    pressure,
  ]);

  return {
    type: LayerType.Path,
    x: minX,
    y: minY,
    width: maxX - minX,
    height: maxY - minY,
    fill: fillColor,
    points: offsetPoints,
    size
  };
};

  /**
   * Convert a list of points to a SVG path string.
   *
   * @param points - List of points in the format `[x, y, pressure]`.
   * @returns A SVG path string that can be used in the "d" attribute of a `<path>` element.
   */
export function convertPointsToPath(points: number[][]): string {
  if (points.length === 0) return "";

  const [startX, startY] = points[0];
  const segments: string[] = [`M${startX},${startY}`];

  for (let i = 0; i < points.length; i++) {
    const [x0, y0] = points[i];
    const [x1, y1] = points[(i + 1) % points.length];
    const midX = (x0 + x1) / 2;
    const midY = (y0 + y1) / 2;
    segments.push(`Q${x0},${y0},${midX},${midY}`);
  }

  segments.push("Z");
  return segments.join(" ");
}

export function isPointNearBoundingBox(point: Point, bounds: { x: number; y: number; width: number; height: number }) {
  const pad = 5;
  return (
    point.x >= bounds.x - pad &&
    point.x <= bounds.x + bounds.width + pad &&
    point.y >= bounds.y - pad &&
    point.y <= bounds.y + bounds.height + pad
  );
}

function distanceToSegment(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;

  if (dx === 0 && dy === 0) {
    const dpx = p.x - a.x;
    const dpy = p.y - a.y;
    return Math.sqrt(dpx * dpx + dpy * dpy);
  }

  const t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy);
  const clampedT = Math.max(0, Math.min(1, t));
  const projX = a.x + clampedT * dx;
  const projY = a.y + clampedT * dy;

  const distX = p.x - projX;
  const distY = p.y - projY;
  return Math.sqrt(distX * distX + distY * distY);
}

export function doesPointIntersectPath(point: Point, path: PathLayer, layerId?: string): boolean {
  const offsetX = path.x;
  const offsetY = path.y;
  const points = path.points;

  for (let i = 0; i < points.length - 1; i++) {
    const a: Point = { x: points[i][0] + offsetX, y: points[i][1] + offsetY };
    const b: Point = { x: points[i + 1][0] + offsetX, y: points[i + 1][1] + offsetY };

    const dist = distanceToSegment(point, a, b);
    if (dist < PATH_ERASE_TOLERANCE ) {
      return true;
    }
  }

  return false;
}


export function getLayerBounds(layer: LiveObject<Layer>) {
  const x = layer.get("x");
  const y = layer.get("y");
  const width = layer.get("width");
  const height = layer.get("height");

  if (
    typeof x === "number" &&
    typeof y === "number" &&
    typeof width === "number" &&
    typeof height === "number"
  ) {
    return { x, y, width, height };
  }

  return null;
}