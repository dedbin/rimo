import { Color, Layer, LayerType, Point } from "@/types/board-canvas";

export const BOARD_SCHEMA_VERSION = 2;
export const MAX_LAYERS = 10_000;
export const MAX_TEXT_LENGTH = 100_000;
export const MAX_CLIPBOARD_BYTES = 2 * 1024 * 1024;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value) &&
  (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
const finite = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= 10_000_000;

export function isColor(value: unknown): value is Color {
  return isRecord(value) && ["r", "g", "b"].every((key) => Object.hasOwn(value, key)) && [value.r, value.g, value.b].every(
    (channel) => typeof channel === "number" && channel >= 0 && channel <= 255,
  ) && (value.a === undefined || (typeof value.a === "number" && value.a >= 0 && value.a <= 1));
}

export function parseLayer(value: unknown): Layer | null {
  if (!isRecord(value)) return null;
  if (!["type", "x", "y", "width", "height"].every((key) => Object.hasOwn(value, key))) return null;
  const { type, x, y, width, height } = value;
  if (![x, y, width, height].every(finite) || (width as number) < 0 || (height as number) < 0) return null;
  if (value.value !== undefined && (typeof value.value !== "string" || value.value.length > MAX_TEXT_LENGTH)) return null;
  if (value.fill !== undefined && !isColor(value.fill)) return null;
  if (value.stroke !== undefined && !isColor(value.stroke)) return null;
  if (value.strokeWidth !== undefined && (!finite(value.strokeWidth) || value.strokeWidth < 0)) return null;
  const base = { x: x as number, y: y as number, width: width as number, height: height as number };
  const text = typeof value.value === "string" ? { value: value.value } : {};
  const fill = isColor(value.fill) ? { ...value.fill } : { r: 0, g: 0, b: 0 };
  switch (type) {
    case LayerType.Rectangle:
    case LayerType.Ellipse:
      return { ...base, ...text, type, fill,
        ...(isColor(value.stroke) ? { stroke: { ...value.stroke } } : {}),
        ...(finite(value.strokeWidth) ? { strokeWidth: value.strokeWidth } : {}),
      };
    case LayerType.Text:
    case LayerType.Sticker: {
      if (!finite(value.fontSize) || value.fontSize < 6 || value.fontSize > 300) return null;
      if (value.fontFamily !== undefined && (typeof value.fontFamily !== "string" || value.fontFamily.length > 100)) return null;
      return { ...base, ...text, type, fill, fontSize: value.fontSize,
        ...(typeof value.fontFamily === "string" ? { fontFamily: value.fontFamily } : {}),
      };
    }
    case LayerType.Path:
      if (!Array.isArray(value.points) || value.points.length < 2 || value.points.length > 50_000) return null;
      if (!value.points.every((point) => Array.isArray(point) && point.length >= 2 && point.length <= 3 && point.every(finite))) return null;
      if (value.size !== undefined && (!finite(value.size) || value.size <= 0 || value.size > 300)) return null;
      return { ...base, type, fill, points: (value.points as number[][]).map((point) => [...point]),
        ...(finite(value.size) ? { size: value.size } : {}),
      };
    case LayerType.Image:
      if (typeof value.src !== "string" || !/^\/api\/assets\/[a-zA-Z0-9_-]+$/.test(value.src)) return null;
      return { ...base, type, src: value.src };
    case LayerType.LinkPreview:
      if (typeof value.value !== "string") return null;
      try {
        const url = new URL(value.value);
        if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || value.value.length > 2048) return null;
      } catch { return null; }
      return { ...base, type, value: value.value,
        ...(typeof value.title === "string" ? { title: value.title.slice(0, 500) } : {}),
        ...(typeof value.description === "string" ? { description: value.description.slice(0, 2000) } : {}),
      };
    default:
      return null;
  }
}

export function createLayer(type: LayerType, position: Point, fill: Color): Layer {
  const bounds = { x: position.x, y: position.y, width: 100, height: 100 };
  switch (type) {
    case LayerType.Rectangle:
    case LayerType.Ellipse:
      return { ...bounds, type, fill: { ...fill } };
    case LayerType.Text:
    case LayerType.Sticker:
      return { ...bounds, type, fill: { ...fill }, value: "", fontSize: 16, fontFamily: "Noto Sans" };
    default:
      throw new Error("Этот тип слоя создаётся отдельной операцией");
  }
}

export function normalizeLayerOrder(ids: readonly string[], layers: ReadonlyMap<string, Layer>): readonly string[] {
  const seen = new Set<string>();
  const ordered = ids.filter((id) => {
    if (!layers.has(id) || seen.has(id)) return false;
    seen.add(id);
    return true;
  });
  for (const id of [...layers.keys()].sort()) {
    if (!seen.has(id)) ordered.push(id);
  }
  return ordered;
}
