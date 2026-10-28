// @vitest-environment node
import type { Connection } from "@hocuspocus/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AccessGuard } from "../access-guard";
import { DeadlineExceededError, withDeadline } from "../deadline";
import { DEFAULT_LIMITS } from "../types";
import type { BoardRole, CollaborationContext, CollaborationDependencies } from "../types";

const guards: AccessGuard[] = [];

function fixture(revalidate: CollaborationDependencies["revalidate"], role: BoardRole = "editor") {
  const guard = new AccessGuard({
    repository: {
      async load() { return null; },
      async save() { return { revision: 1, savedAt: new Date() }; },
      async health() { return true; },
    },
    async authenticate() { return null; }, revalidate,
  }, DEFAULT_LIMITS);
  guards.push(guard);
  const context = guard.reserve({ boardId: "PRIVATE_BOARD", userId: "PRIVATE_USER", sessionId: "PRIVATE_SESSION",
    name: "PRIVATE_NAME", role }, "PRIVATE_SOCKET");
  const connection = { context, readOnly: role === "viewer", close: vi.fn(), sendStateless: vi.fn() };
  guard.activate(connection as unknown as Connection<CollaborationContext>);
  vi.advanceTimersByTime(DEFAULT_LIMITS.aclRefreshMs);
  return { guard, context, connection };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval", "performance"] });
  vi.setSystemTime(0);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});
afterEach(() => {
  guards.splice(0).forEach((guard) => guard.stop());
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function expectEvent(kind: "timeout" | "dependency-error" | "denied" | "editor-limit", elapsedMs: number): void {
  const calls = vi.mocked(console.warn).mock.calls;
  expect(calls).toHaveLength(1);
  expect(calls[0]).toHaveLength(1);
  expect(JSON.parse(calls[0][0] as string)).toEqual({ event: "collaboration_access_check_failed", kind, elapsedMs });
  expect(calls[0][0]).not.toContain("PRIVATE_");
}

describe("access-check failure diagnostics", () => {
  it("preserves the timeout text and identifies the deadline by its error type", async () => {
    const result = withDeadline(new Promise<never>(() => undefined), DEFAULT_LIMITS.aclCheckTimeoutMs);
    const rejection = expect(result).rejects.toBeInstanceOf(DeadlineExceededError);
    const message = expect(result).rejects.toThrow("Access check timed out");
    await vi.advanceTimersByTimeAsync(DEFAULT_LIMITS.aclCheckTimeoutMs);
    await Promise.all([rejection, message]);
    expect(console.warn).not.toHaveBeenCalled();
  });

  it("reports one timeout for coalesced callers, with the unchanged denial and no later logging loop", async () => {
    const revalidate = vi.fn(() => new Promise<BoardRole | null>(() => undefined));
    const { guard, context, connection } = fixture(revalidate);
    const checks = Promise.allSettled([guard.checkAccess(context), guard.checkAccess(context)]);
    await vi.advanceTimersByTimeAsync(DEFAULT_LIMITS.aclCheckTimeoutMs);
    expect((await checks).every((entry) => entry.status === "rejected")).toBe(true);
    expect(revalidate).toHaveBeenCalledOnce();
    expect(connection.close).toHaveBeenCalledOnce();
    expect(connection.close).toHaveBeenCalledWith({ code: 1008, reason: "Access revoked or unavailable" });
    expectEvent("timeout", DEFAULT_LIMITS.aclCheckTimeoutMs);
    guard.start();
    await vi.advanceTimersByTimeAsync(DEFAULT_LIMITS.aclRefreshMs * 2);
    await expect(guard.checkAccess(context)).rejects.toThrow("Access revoked");
    expectEvent("timeout", DEFAULT_LIMITS.aclCheckTimeoutMs);
  });

  it.each(["PRIVATE_SQL_WITH_COOKIE", "Access check timed out"])("classifies an ordinary dependency rejection without printing it: %s", async (message) => {
    const { guard, context, connection } = fixture(async () => { throw new Error(message); });
    await expect(guard.checkAccess(context)).rejects.toThrow("Access revoked");
    expect(connection.close).toHaveBeenCalledOnce();
    expectEvent("dependency-error", 0);
  });

  it("classifies an explicit missing permission as denied", async () => {
    const { guard, context, connection } = fixture(async () => null);
    await expect(guard.checkAccess(context)).rejects.toThrow("Access revoked");
    expect(connection.close).toHaveBeenCalledOnce();
    expectEvent("denied", 0);
  });

  it("distinguishes an authorized promotion blocked by ten occupied editor slots from an ACL denial", async () => {
    const { guard, context, connection } = fixture(async () => "editor", "viewer");
    const editors = Array.from({ length: DEFAULT_LIMITS.maxEditors }, (_, index) => {
      const editorContext = guard.reserve({ boardId: `PRIVATE_EDITOR_BOARD_${index}`, userId: `PRIVATE_EDITOR_${index}`,
        sessionId: `PRIVATE_EDITOR_SESSION_${index}`, name: "PRIVATE_EDITOR_NAME", role: "editor" }, `PRIVATE_EDITOR_SOCKET_${index}`);
      const editor = { context: editorContext, readOnly: false, close: vi.fn(), sendStateless: vi.fn() };
      guard.activate(editor as unknown as Connection<CollaborationContext>);
      return editor;
    });
    await expect(guard.checkAccess(context)).rejects.toThrow("Access revoked");
    expect(connection.context.role).toBe("viewer");
    expect(connection.close).toHaveBeenCalledOnce();
    expect(connection.sendStateless).not.toHaveBeenCalled();
    expect(editors).toHaveLength(10);
    expect(editors.every((editor) => editor.context.role === "editor" && !editor.close.mock.calls.length)).toBe(true);
    expectEvent("editor-limit", 0);
  });

  it.each([["editor", "viewer"], ["viewer", "editor"]] as const)("keeps a valid %s to %s transition silent", async (previous, next) => {
    const { guard, context, connection } = fixture(async () => next, previous);
    await expect(guard.checkAccess(context)).resolves.toBeUndefined();
    expect(connection.context.role).toBe(next);
    expect(connection.readOnly).toBe(next === "viewer");
    expect(connection.close).not.toHaveBeenCalled();
    expect(connection.sendStateless).toHaveBeenCalledWith(JSON.stringify({ type: "access-role", role: next }));
    expect(console.warn).not.toHaveBeenCalled();
  });

  it.each(["released", "stopped"])("does not log or close a late timeout after its reservation was %s", async (mode) => {
    const { guard, context, connection } = fixture(() => new Promise<BoardRole | null>(() => undefined));
    const rejection = expect(guard.checkAccess(context)).rejects.toThrow("Access revoked");
    if (mode === "released") guard.release(context.reservationId);
    else guard.stop();
    await vi.advanceTimersByTimeAsync(DEFAULT_LIMITS.aclCheckTimeoutMs);
    await rejection;
    expect(connection.close).not.toHaveBeenCalled();
    expect(console.warn).not.toHaveBeenCalled();
  });
});
