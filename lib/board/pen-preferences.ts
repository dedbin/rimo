import type { Color } from "@/types/board-canvas";

export const PEN_SIZES: readonly number[] = Object.freeze([4, 8, 12, 16, 24, 32]);

export interface PenPreferences {
  readonly color: Color;
  readonly size: number;
}

export function defaultPenPreferences(): PenPreferences {
  return { color: { r: 0, g: 0, b: 0 }, size: 16 };
}

export function penPreferencesKey(userId: string): string {
  return `rimo:pen-preferences:v1:${encodeURIComponent(userId)}`;
}

export function validPenColor(value: unknown): Color | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  const { r, g, b, a } = candidate;
  if (![r, g, b].every((channel) => typeof channel === "number" && Number.isInteger(channel) && channel >= 0 && channel <= 255)) return null;
  if (a !== undefined && (typeof a !== "number" || !Number.isFinite(a) || a < 0 || a > 1)) return null;
  return { r: r as number, g: g as number, b: b as number, ...(a !== undefined ? { a: a as number } : {}) };
}

export function parsePenPreferences(raw: string | null): PenPreferences {
  if (!raw || raw.length > 512) return defaultPenPreferences();
  try {
    const candidate: unknown = JSON.parse(raw);
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return defaultPenPreferences();
    const { version, color, size } = candidate as Record<string, unknown>;
    const validColor = validPenColor(color);
    if (version !== 1 || !validColor || typeof size !== "number" || !PEN_SIZES.includes(size)) return defaultPenPreferences();
    return { color: validColor, size };
  } catch {
    return defaultPenPreferences();
  }
}
