import { Buffer } from "node:buffer";

import { isColor } from "../lib/board/model";

import { CollaborationRejection } from "./types";
import type { CollaborationContext } from "./types";

function point(value: unknown): boolean {
  if (typeof value !== "object" || value === null || !("x" in value) || !("y" in value)) return false;
  return [value.x, value.y].every((coordinate) => typeof coordinate === "number" && Number.isFinite(coordinate) && Math.abs(coordinate) < 10_000_000);
}

function draft(value: unknown): boolean {
  return value === null || (Array.isArray(value) && value.length <= 20_000 && value.every(
    (entry) => Array.isArray(entry) && entry.length >= 2 && entry.length <= 3 && entry.every(
      (coordinate) => typeof coordinate === "number" && Number.isFinite(coordinate) && Math.abs(coordinate) < 10_000_000,
    ),
  ));
}

export class AwarenessGuard {
  private readonly clients = new Map<string, number>();
  private readonly owners = new Map<string, string>();

  filter(
    context: CollaborationContext,
    states: Map<number, Record<string, unknown>>,
    removedClients: Set<number>,
  ): void {
    if (states.size > 1) throw new CollaborationRejection("Invalid presence update");
    for (const [clientId, state] of states) {
      const key = `${context.boardId}:${clientId}`;
      const previous = this.clients.get(context.reservationId);
      const owner = this.owners.get(key);
      if ((previous !== undefined && previous !== clientId) || (owner && owner !== context.reservationId)) {
        throw new CollaborationRejection("Invalid presence identity");
      }
      if (Buffer.byteLength(JSON.stringify(state)) > 256 * 1024) {
        throw new CollaborationRejection("Presence limit reached");
      }
      this.clients.set(context.reservationId, clientId);
      this.owners.set(key, context.reservationId);
      const input = typeof state.presence === "object" && state.presence !== null
        ? state.presence as Record<string, unknown> : {};
      const selection = Array.isArray(input.selection)
        ? input.selection.filter((id) => typeof id === "string" && id.length <= 128).slice(0, 10_000)
        : [];
      const drag = typeof input.drag === "object" && input.drag !== null
        ? input.drag as Record<string, unknown> : {};
      const dragIds = Array.isArray(drag.ids)
        ? drag.ids.filter((id) => typeof id === "string" && id.length <= 128).slice(0, 10_000) : [];
      states.set(clientId, {
        user: { id: context.userId, name: context.name, ...(context.image ? { picture: context.image } : {}) },
        presence: {
          cursor: input.cursor === null || point(input.cursor) ? input.cursor : null,
          selection,
          pencilDraft: draft(input.pencilDraft) ? input.pencilDraft : null,
          penColor: isColor(input.penColor) ? input.penColor : null,
          penSize: typeof input.penSize === "number" && input.penSize > 0 && input.penSize <= 300 ? input.penSize : 2,
          eraserDraft: Array.isArray(input.eraserDraft) && input.eraserDraft.length <= 20_000
            ? input.eraserDraft.filter(point) : null,
          drag: point(drag.delta) ? { ids: dragIds, delta: drag.delta } : null,
        },
      });
    }
    for (const clientId of removedClients) {
      if (clientId !== this.clients.get(context.reservationId)) removedClients.delete(clientId);
    }
  }

  release(context: CollaborationContext): void {
    const clientId = this.clients.get(context.reservationId);
    if (clientId !== undefined) this.owners.delete(`${context.boardId}:${clientId}`);
    this.clients.delete(context.reservationId);
  }
}
