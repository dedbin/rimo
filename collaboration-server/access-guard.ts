import { randomUUID } from "node:crypto";

import type { Connection } from "@hocuspocus/server";

import type { AccessRoleMessage } from "../lib/collaboration/protocol";
import { DeadlineExceededError, withDeadline } from "./deadline";
import { CollaborationRejection } from "./types";
import type {
  BoardRole,
  CollaborationContext,
  CollaborationDependencies,
  CollaborationLimits,
  CollaborationPrincipal,
  ConnectionReservation,
} from "./types";

type AccessCheckFailure = "timeout" | "dependency-error" | "denied" | "editor-limit";

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
    const now = performance.now();
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
    const now = performance.now();
    if (now - entry.checkedAt >= this.limits.aclRefreshMs) {
      await this.refresh(context.reservationId);
      if (!this.reservations.has(context.reservationId)) throw new CollaborationRejection("Access revoked");
    }
  }

  start(): void {
    this.timer = setInterval(() => {
      this.prunePending();
      const now = performance.now();
      for (const [id, entry] of this.reservations) {
        if (entry.connection && now - entry.checkedAt >= this.limits.aclRefreshMs) void this.refresh(id);
      }
    }, Math.min(1_000, this.limits.aclRefreshMs));
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
    const started = performance.now();
    const pending = withDeadline(this.dependencies.revalidate(entry.context), this.limits.aclCheckTimeoutMs)
      .then((role) => this.applyRole(id, role, started, "denied"))
      .catch((error: unknown) => this.applyRole(id, null, started,
        error instanceof DeadlineExceededError ? "timeout" : "dependency-error"));
    this.checks.set(id, pending);
    try {
      await pending;
    } finally {
      this.checks.delete(id);
    }
  }

  private applyRole(id: string, role: BoardRole | null, started: number, kind: AccessCheckFailure): void {
    const entry = this.reservations.get(id);
    if (!entry) return;
    const promoted = entry.context.role === "viewer" && role !== "viewer";
    if (!role || (promoted && this.editorCount() >= this.limits.maxEditors)) {
      console.warn(JSON.stringify({ event: "collaboration_access_check_failed", kind: role ? "editor-limit" : kind,
        elapsedMs: Math.max(0, Math.round(performance.now() - started)) }));
      entry.connection?.close({ code: 1008, reason: "Access revoked or unavailable" });
      this.reservations.delete(id);
      return;
    }
    const previousRole = entry.context.role;
    // A slow response may describe the role at query start, not its completion.
    entry.checkedAt = started;
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
      if (!entry.connection && performance.now() - entry.checkedAt > 10_000) this.reservations.delete(id);
    }
  }
}
