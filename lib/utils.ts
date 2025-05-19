import { Camera, Color } from "@/types/board-canvas"
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
