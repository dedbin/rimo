import { randomUUID } from "node:crypto";

import type { Connection } from "@hocuspocus/server";

import type { AccessRoleMessage } from "../lib/collaboration/protocol";
import { withDeadline } from "./deadline";
import { CollaborationRejection } from "./types";
import type {
  BoardRole,
  CollaborationContext,
  CollaborationDependencies,
  CollaborationLimits,
  CollaborationPrincipal,
  ConnectionReservation,
} from "./types";

export class AccessGuard {
  private readonly reservations = new Map<string, ConnectionReservation>();
  private readonly checks = new Map<string, Promise<void>>();
  private timer?: ReturnType<typeof setInterval>;

  constructor(
    private readonly dependencies: CollaborationDependencies,
    private readonly limits: CollaborationLimits,
  ) {}

  reserve(principal: CollaborationPrincipal, socketId: string): CollaborationContext {
    this.prunePending();
    if (this.reservations.size >= this.limits.maxConnections) {
      throw new CollaborationRejection("Server connection limit reached");
    }
    const room = [...this.reservations.values()].filter((entry) => entry.context.boardId === principal.boardId);
    if (room.length >= this.limits.maxRoomConnections) {
      throw new CollaborationRejection("Board connection limit reached");
    }
    if (principal.role !== "viewer" && this.editorCount() >= this.limits.maxEditors) {
      throw new CollaborationRejection("Server editor limit reached");
    }
    const now = Date.now();
    const context = { ...principal, reservationId: randomUUID() };
    this.reservations.set(context.reservationId, {
      context, socketId, checkedAt: now,
    });
    return context;
  }

  activate(connection: Connection<CollaborationContext>): void {
    const reservation = this.reservations.get(connection.context.reservationId);
    if (!reservation) throw new CollaborationRejection("Connection reservation expired");
    reservation.connection = connection;
  }

  release(reservationId: string): void {
    this.reservations.delete(reservationId);
  }

  async checkAccess(context: CollaborationContext): Promise<void> {
    const entry = this.reservations.get(context.reservationId);
    if (!entry) throw new CollaborationRejection("Access revoked");
    const now = Date.now();
    if (now - entry.checkedAt >= this.limits.aclRefreshMs) {
      await this.refresh(context.reservationId);
      if (!this.reservations.has(context.reservationId)) throw new CollaborationRejection("Access revoked");
    }
  }

  start(): void {
    this.timer = setInterval(() => {
      this.prunePending();
      for (const [id, entry] of this.reservations) {
        if (entry.connection) void this.refresh(id);
      }
    }, this.limits.aclRefreshMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.reservations.clear();
  }

  private editorCount(): number {
    return [...this.reservations.values()].filter((entry) => entry.context.role !== "viewer").length;
  }

  private async refresh(id: string): Promise<void> {
    const existing = this.checks.get(id);
    if (existing) return existing;
    const entry = this.reservations.get(id);
    if (!entry) return;
    const pending = withDeadline(this.dependencies.revalidate(entry.context), this.limits.aclCheckTimeoutMs)
      .then((role) => this.applyRole(id, role))
      .catch(() => this.applyRole(id, null));
    this.checks.set(id, pending);
    try {
      await pending;
    } finally {
      this.checks.delete(id);
    }
  }

  private applyRole(id: string, role: BoardRole | null): void {
    const entry = this.reservations.get(id);
    if (!entry) return;
    const promoted = entry.context.role === "viewer" && role !== "viewer";
    if (!role || (promoted && this.editorCount() >= this.limits.maxEditors)) {
      entry.connection?.close({ code: 1008, reason: "Access revoked or unavailable" });
      this.reservations.delete(id);
      return;
    }
    const previousRole = entry.context.role;
    entry.checkedAt = Date.now();
    entry.context = { ...entry.context, role };
    if (entry.connection) {
      entry.connection.context = entry.context;
      entry.connection.readOnly = role === "viewer";
      if (previousRole !== role) {
        const snapshot: AccessRoleMessage = { type: "access-role", role };
        entry.connection.sendStateless(JSON.stringify(snapshot));
      }
    }
  }

  private prunePending(): void {
    for (const [id, entry] of this.reservations) {
      if (!entry.connection && Date.now() - entry.checkedAt > 10_000) this.reservations.delete(id);
    }
  }
}
