// @vitest-environment node

import { randomUUID } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import { AccessGuard } from "../collaboration-server/access-guard";
import { getCollaborationAdmissionLimits } from "../collaboration-server/config";
import { DEFAULT_LIMITS } from "../collaboration-server/types";
import type { CollaborationDependencies, CollaborationPrincipal } from "../collaboration-server/types";

const variables = [
  "COLLABORATION_MAX_CONNECTIONS", "COLLABORATION_MAX_ROOM_CONNECTIONS",
  "COLLABORATION_MAX_EDITORS", "COLLABORATION_MAX_OPEN_DOCUMENTS",
] as const;

describe("bounded collaboration admission configuration", () => {
  it("preserves defaults without exposing document or queue protections as overrides", () => {
    expect(getCollaborationAdmissionLimits({})).toEqual({
      maxConnections: 50, maxRoomConnections: 10, maxEditors: 10, maxOpenDocuments: 10,
    });
    expect(Object.isFrozen(getCollaborationAdmissionLimits({}))).toBe(true);
  });

  it("accepts the target of twenty lessons and forty editor connections without changing protections", () => {
    expect(getCollaborationAdmissionLimits({
      COLLABORATION_MAX_CONNECTIONS: "50", COLLABORATION_MAX_ROOM_CONNECTIONS: "10",
      COLLABORATION_MAX_EDITORS: "40", COLLABORATION_MAX_OPEN_DOCUMENTS: "20",
    })).toEqual({ maxConnections: 50, maxRoomConnections: 10, maxEditors: 40, maxOpenDocuments: 20 });
    expect(DEFAULT_LIMITS.maxEditors).toBe(10);
    expect(DEFAULT_LIMITS.maxDocumentBytes).toBe(5 * 1024 * 1024);
  });

  it.each(variables)("rejects missing bounds and malformed numbers for %s", (name) => {
    for (const value of ["", "0", "-1", "1.5", "1e1", " 10 ", "Infinity", "51", "999999999999999999999"]) {
      expect(() => getCollaborationAdmissionLimits({ [name]: value })).toThrow(name);
    }
  });

  it.each(variables.slice(1))("rejects %s above the total connection cap", (name) => {
    expect(() => getCollaborationAdmissionLimits({
      COLLABORATION_MAX_CONNECTIONS: "2", COLLABORATION_MAX_ROOM_CONNECTIONS: "1",
      COLLABORATION_MAX_EDITORS: "1", COLLABORATION_MAX_OPEN_DOCUMENTS: "1", [name]: "3",
    })).toThrow(`${name} must not exceed COLLABORATION_MAX_CONNECTIONS`);
  });
});

function principal(boardId: string, role: "editor" | "viewer" = "editor"): CollaborationPrincipal {
  const id = randomUUID();
  return { boardId, userId: id, sessionId: id, name: "Admission test", role };
}

function guard(overrides: Record<string, string>): AccessGuard {
  const dependencies: CollaborationDependencies = {
    repository: { load: vi.fn(), save: vi.fn(), health: vi.fn() },
    authenticate: vi.fn(), revalidate: vi.fn(),
  };
  return new AccessGuard(dependencies, { ...DEFAULT_LIMITS, ...getCollaborationAdmissionLimits({
    COLLABORATION_MAX_CONNECTIONS: "4", COLLABORATION_MAX_ROOM_CONNECTIONS: "2",
    COLLABORATION_MAX_EDITORS: "2", COLLABORATION_MAX_OPEN_DOCUMENTS: "2", ...overrides,
  }) });
}

describe("admission slots are finite and released", () => {
  it("shares editor capacity across rooms while permitting viewers, and reuses a released slot", () => {
    const admission = guard({});
    const first = admission.reserve(principal("first"), "one");
    admission.reserve(principal("second"), "two");
    admission.reserve(principal("third", "viewer"), "viewer");
    expect(() => admission.reserve(principal("fourth"), "full")).toThrow("Server editor limit reached");
    admission.release(first.reservationId);
    expect(() => admission.reserve(principal("fourth"), "replacement")).not.toThrow();
    admission.stop();
  });

  it("rejects a full board without consuming a free server slot", () => {
    const admission = guard({ COLLABORATION_MAX_EDITORS: "4" });
    const first = admission.reserve(principal("first"), "one");
    admission.reserve(principal("first"), "two");
    expect(() => admission.reserve(principal("first", "viewer"), "full")).toThrow("Board connection limit reached");
    expect(() => admission.reserve(principal("second"), "other-board")).not.toThrow();
    admission.release(first.reservationId);
    expect(() => admission.reserve(principal("first", "viewer"), "replacement")).not.toThrow();
    admission.stop();
  });

  it("counts viewers in the total cap and admits a new connection after release", () => {
    const admission = guard({});
    const entries = [0, 1, 2, 3].map(index => admission.reserve(principal(String(index), "viewer"), String(index)));
    expect(() => admission.reserve(principal("new", "viewer"), "full")).toThrow("Server connection limit reached");
    admission.release(entries[1].reservationId);
    expect(() => admission.reserve(principal("new", "viewer"), "replacement")).not.toThrow();
    admission.stop();
  });
});
