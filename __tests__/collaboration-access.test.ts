// @vitest-environment node

import { randomUUID } from "node:crypto";

import { beforeEach, describe, expect, it, vi } from "vitest";

import { createCollaborationDependencies } from "../collaboration-server/dependencies";
import { getCollaborationRole } from "../server/collaboration-access";
import type { BoardRole } from "../types/service";

const { query, getSession } = vi.hoisted(() => ({ query: vi.fn(), getSession: vi.fn() }));
vi.mock("../server/db", () => ({ getPool: () => ({ query }) }));
vi.mock("../server/auth", () => ({ getAuth: () => ({ api: { getSession } }) }));

const principal = {
  sessionId: randomUUID(), userId: randomUUID(), boardId: randomUUID(), name: "Тест",
  role: "owner" as const,
};

describe("single-query collaboration revalidation", () => {
  beforeEach(() => { query.mockReset(); getSession.mockReset(); });

  it.each<BoardRole>(["owner", "editor", "viewer"])("returns the current %s role in one parameterized query", async (role) => {
    query.mockResolvedValue({ rows: [{ role }] });
    expect(await getCollaborationRole(principal.sessionId, principal.userId, principal.boardId)).toBe(role);
    expect(query).toHaveBeenCalledOnce();
    const [sql, parameters] = query.mock.calls[0];
    expect(parameters).toEqual([principal.sessionId, principal.userId, principal.boardId]);
    for (const value of parameters) expect(sql).not.toContain(value);
    expect(sql).toContain('s."expiresAt" > now()');
  });

  it("returns null when the session/board ACL join has no row", async () => {
    query.mockResolvedValue({ rows: [] });
    expect(await getCollaborationRole(principal.sessionId, principal.userId, principal.boardId)).toBeNull();
    expect(query).toHaveBeenCalledOnce();
  });

  it("rejects an invalid board UUID without sending an SQL cast", async () => {
    expect(await getCollaborationRole(principal.sessionId, principal.userId, "not-a-uuid")).toBeNull();
    expect(query).not.toHaveBeenCalled();
  });

  it("propagates database errors for the existing dependency-error fail-closed path", async () => {
    const error = new Error("Database unavailable");
    query.mockRejectedValue(error);
    await expect(getCollaborationRole(principal.sessionId, principal.userId, principal.boardId)).rejects.toBe(error);
  });

  it("revalidates from the database each time and never falls back to the principal role", async () => {
    query.mockResolvedValueOnce({ rows: [{ role: "editor" }] })
      .mockResolvedValueOnce({ rows: [{ role: "viewer" }] }).mockResolvedValueOnce({ rows: [] });
    const dependencies = createCollaborationDependencies();
    expect(await dependencies.revalidate(principal)).toBe("editor");
    expect(await dependencies.revalidate(principal)).toBe("viewer");
    expect(await dependencies.revalidate(principal)).toBeNull();
    expect(query).toHaveBeenCalledTimes(3);
    expect(getSession).not.toHaveBeenCalled();
  });

  it("keeps initial cookie authentication in Better Auth with its cookie cache disabled", async () => {
    const headers = new Headers({ cookie: "test-runtime-cookie" });
    getSession.mockResolvedValue({
      user: { id: principal.userId, name: principal.name, isAnonymous: true },
      session: { id: principal.sessionId },
    });
    query.mockResolvedValue({ rows: [{ role: "editor" }] });
    const accepted = await createCollaborationDependencies().authenticate(headers, principal.boardId);
    expect(getSession).toHaveBeenCalledWith({ headers, query: { disableCookieCache: true } });
    expect(accepted).toEqual({ ...principal, role: "editor" });
    expect(query).toHaveBeenCalledOnce();
  });

  it("keeps invalid initial cookie authentication denied before querying board ACL", async () => {
    getSession.mockResolvedValue(null);
    expect(await createCollaborationDependencies().authenticate(new Headers(), principal.boardId)).toBeNull();
    expect(query).not.toHaveBeenCalled();
  });
});
