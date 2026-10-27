import { Color, Point } from "@/types/board-canvas";
import { safeAvatarSrc } from "@/lib/safe-avatar";

export interface BoardPresence {
  cursor: Point | null;
  selection: string[];
  pencilDraft: number[][] | null;
  penColor: Color | null;
  penSize: number;
  eraserDraft: Point[] | null;
  drag: { ids: string[]; delta: Point } | null;
}

export interface BoardParticipant {
  connectionId: number;
  info: { id: string; name: string; picture?: string };
  presence: BoardPresence;
}

export const emptyPresence = (): BoardPresence => ({
  cursor: null, selection: [], pencilDraft: null, penColor: null,
  penSize: 16, eraserDraft: null, drag: null,
});

function point(value: unknown): Point | null {
  if (typeof value !== "object" || value === null || !("x" in value) || !("y" in value)) return null;
  return typeof value.x === "number" && Number.isFinite(value.x) &&
    typeof value.y === "number" && Number.isFinite(value.y) ? { x: value.x, y: value.y } : null;
}

export function parseParticipant(connectionId: number, state: Record<string, unknown>): BoardParticipant | null {
  const user = state.user;
  const input = state.presence;
  if (typeof user !== "object" || user === null || !("name" in user) || typeof user.name !== "string") return null;
  if (typeof input !== "object" || input === null) return null;
  const raw = input as Record<string, unknown>;
  const presence = emptyPresence();
  presence.cursor = point(raw.cursor);
  if (Array.isArray(raw.selection)) presence.selection = raw.selection.filter((id): id is string => typeof id === "string").slice(0, 10_000);
  if (Array.isArray(raw.pencilDraft) && raw.pencilDraft.length <= 5000) {
    const draft = raw.pencilDraft.filter((p): p is number[] => Array.isArray(p) && p.length >= 2 && p.length <= 3 && p.every((n) => typeof n === "number" && Number.isFinite(n)));
    presence.pencilDraft = draft.length ? draft : null;
  }
  if (typeof raw.penSize === "number" && raw.penSize > 0 && raw.penSize <= 300) presence.penSize = raw.penSize;
  if (Array.isArray(raw.eraserDraft)) {
    presence.eraserDraft = raw.eraserDraft.slice(-5000).map(point).filter((p): p is Point => p !== null);
  }
  if (typeof raw.penColor === "object" && raw.penColor !== null) {
    const color = raw.penColor as Record<string, unknown>;
    if ([color.r, color.g, color.b].every((n) => typeof n === "number" && n >= 0 && n <= 255)) {
      presence.penColor = { r: color.r as number, g: color.g as number, b: color.b as number };
    }
  }
  if (typeof raw.drag === "object" && raw.drag !== null && "ids" in raw.drag && "delta" in raw.drag) {
    const delta = point(raw.drag.delta);
    const ids = Array.isArray(raw.drag.ids) ? raw.drag.ids.filter((id): id is string => typeof id === "string").slice(0, 10_000) : [];
    if (delta) presence.drag = { ids, delta };
  }
  const picture = "picture" in user ? safeAvatarSrc(user.picture) : undefined;
  return { connectionId, info: {
    id: "id" in user && typeof user.id === "string" ? user.id : String(connectionId),
    name: user.name.slice(0, 100),
    ...(picture ? { picture } : {}),
  }, presence };
}
