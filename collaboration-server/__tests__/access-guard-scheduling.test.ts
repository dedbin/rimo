// @vitest-environment node
import type { Connection } from "@hocuspocus/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AccessGuard } from "../access-guard";
import { DEFAULT_LIMITS } from "../types";
import type { BoardRole, CollaborationContext, CollaborationDependencies } from "../types";

const guards: AccessGuard[] = [];

function fixture(revalidate: CollaborationDependencies["revalidate"]) {
  const guard = new AccessGuard({
    repository: { async load() { return null; }, async save() { return { revision: 1, savedAt: new Date() }; }, async health() { return true; } },
    async authenticate() { return null; }, revalidate,
  }, DEFAULT_LIMITS);
  guards.push(guard);
  const reserve = (index: number) => {
    const context = guard.reserve({ boardId: `board-${index}`, userId: `user-${index}`,
      sessionId: `session-${index}`, name: "Test", role: "viewer" }, `socket-${index}`);
    const connection = { context, readOnly: true, close: vi.fn(), sendStateless: vi.fn() };
    guard.activate(connection as unknown as Connection<CollaborationContext>);
    return { context, connection };
  };
  return { guard, reserve };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval", "performance"] });
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});
afterEach(() => { guards.splice(0).forEach(guard => guard.stop()); vi.useRealTimers(); vi.restoreAllMocks(); });

describe("per-connection monotonic access refresh", () => {
  it("refreshes only aged connections instead of refreshing every room in the same timer batch", async () => {
    const observations: { userId: string; at: number }[] = [];
    const { guard, reserve } = fixture(async principal => {
      observations.push({ userId: principal.userId, at: performance.now() }); return "viewer";
    });
    reserve(0); guard.start();
    await vi.advanceTimersByTimeAsync(2_000); reserve(1);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(observations).toEqual([{ userId: "user-0", at: 5_000 }]);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(observations).toEqual([{ userId: "user-0", at: 5_000 }, { userId: "user-1", at: 7_000 }]);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(observations.at(-1)).toEqual({ userId: "user-0", at: 10_000 });
  });

  it.each([-3_600_000, 3_600_000])("keeps revocation below ten seconds through a wall-clock adjustment of %s ms", async offset => {
    const revalidate = vi.fn(() => new Promise<BoardRole | null>(resolve => setTimeout(() => resolve(null), 2_999)));
    const { guard, reserve } = fixture(revalidate);
    guard.start();
    await vi.advanceTimersByTimeAsync(100);
    const { context, connection } = reserve(0);
    vi.setSystemTime(Date.now() + offset);
    await guard.checkAccess(context);
    expect(revalidate).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(5_899);
    expect(revalidate).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(revalidate).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(2_999);
    expect(connection.close).toHaveBeenCalledWith({ code: 1008, reason: "Access revoked or unavailable" });
    expect(performance.now() - 100).toBe(8_899);
    await expect(guard.checkAccess(context)).rejects.toThrow("Access revoked");
  });

  it("shares one in-flight lookup across periodic ticks and still closes at the original deadline", async () => {
    const revalidate = vi.fn(() => new Promise<BoardRole | null>(() => undefined));
    const { guard, reserve } = fixture(revalidate);
    const { connection } = reserve(0); guard.start();
    await vi.advanceTimersByTimeAsync(7_999);
    expect(revalidate).toHaveBeenCalledOnce();
    expect(connection.close).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(connection.close).toHaveBeenCalledOnce();
    expect(revalidate).toHaveBeenCalledOnce();
  });

  it("does not postpone revocation by measuring freshness from a delayed successful response", async () => {
    let role: BoardRole | null = "viewer";
    const revalidate = vi.fn(() => {
      const capturedRole = role;
      return new Promise<BoardRole | null>(resolve => setTimeout(() => resolve(capturedRole), 2_999));
    });
    const { guard, reserve } = fixture(revalidate);
    const { connection } = reserve(0); guard.start();
    await vi.advanceTimersByTimeAsync(5_001);
    role = null;
    await vi.advanceTimersByTimeAsync(2_998);
    expect(connection.close).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2_001);
    expect(revalidate).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(2_999);
    expect(connection.close).toHaveBeenCalledOnce();
    expect(performance.now() - 5_001).toBeLessThan(10_000);
  });
});
