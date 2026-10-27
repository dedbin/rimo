import type { Color } from "../../types/board-canvas";

export function rgbToCss(color: Color): string {
  const channels = [color.r, color.g, color.b];
  if (color.a !== undefined || !channels.every(Number.isInteger)) {
    return `rgba(${color.r},${color.g},${color.b},${color.a ?? 1})`;
  }
  return `#${channels.map((channel) => channel.toString(16).padStart(2, "0")).join("")}`;
}

export function getContrastingTextColor(color: Color): "black" | "white" {
  const luminance = 0.299 * color.r + 0.587 * color.g + 0.114 * color.b;
  return luminance > 182 ? "black" : "white";
}
