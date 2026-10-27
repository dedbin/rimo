// @vitest-environment node
import { randomUUID } from "node:crypto";

import { OutgoingMessage } from "@hocuspocus/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";

import { DEFAULT_LIMITS } from "../types";
import { insertRectangle, waitFor } from "./helpers";
import { cleanupIngress, ingressBarrier, ingressFixture } from "./ingress-fixture";

const timers: ReturnType<typeof setTimeout>[] = [];

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(async () => {
  timers.splice(0).forEach(clearTimeout);
  await cleanupIngress();
});

async function delayedAccess(maxQueuedMessages: number, releaseAfterMs?: number) {
  const barrier = ingressBarrier();
  let armed = false;
  let started = false;
  const context = await ingressFixture((dependencies) => {
    dependencies.revalidate = async (principal) => {
      if (armed && principal.userId === "writer") {
        armed = false;
        started = true;
        if (releaseAfterMs !== undefined) timers.push(setTimeout(barrier.release, releaseAfterMs));
        await barrier.waiting;
      }
      return principal.role;
    };
  }, { maxQueuedMessages, aclRefreshMs: 25 });
  const boardId = randomUUID();
  const writer = context.provider(boardId);
  await writer.connect();
  insertRectangle(writer.document, "rectangle");
  await waitFor(() => writer.isPersisted());
  return { ...context, boardId, writer,
    async hold(): Promise<void> {
      armed = true;
      await waitFor(() => started);
      const forwardedBefore = context.forwarded.length;
      writer.provider.sendStateless(JSON.stringify({ type: "persistence-status" }));
      await waitFor(() => context.forwarded.length > forwardedBefore);
    } };
}

describe("bounded receive queue during a legal access refresh", () => {
  it.each([32, 64] as const)("handles normal cursor traffic behind a delayed ACL with a %i-frame budget", async (frames) => {
    // The UI emits cursor presence up to 20 Hz; the two-second hold stays below the unchanged 3 s ACL deadline.
    const context = await delayedAccess(frames, 2_250);
    const observer = context.provider(context.boardId, "viewer");
    await observer.connect();
    const closed = vi.fn();
    context.writer.provider.on("close", () => { closed(); context.writer.websocketProvider.disconnect(); });
    await context.hold();
    for (let index = 0; index < 40; index += 1) {
      context.writer.provider.awareness!.setLocalStateField("presence", { cursor: { x: index, y: -index } });
      if (index % 10 === 0) context.writer.document.getMap<Y.Map<unknown>>("layers").get("rectangle")!.set("x", index + 10);
      await new Promise<void>((resolve) => setTimeout(resolve, 50));
    }
    if (frames === 32) {
      await waitFor(() => closed.mock.calls.length > 0);
      const limits = vi.mocked(console.warn).mock.calls.map(([value]) => JSON.parse(String(value)));
      expect(limits).toContainEqual(expect.objectContaining({ event: "collaboration_receive_limit", kind: "queued-messages", queuedFrames: 32 }));
      return;
    }
    await waitFor(() => context.writer.isPersisted() &&
      observer.document.getMap<Y.Map<unknown>>("layers").get("rectangle")?.get("x") === 40 &&
      observer.provider.awareness!.getStates().get(context.writer.document.clientID)?.presence?.cursor?.x === 39);
    expect(closed).not.toHaveBeenCalled();
    expect(context.server.hocuspocus.getConnectionsCount()).toBe(2);
    expect(context.snapshots.get(context.boardId)!.revision).toBe(context.writer.lastAcknowledgement()!.revision);
    const persisted = new Y.Doc();
    try {
      Y.applyUpdate(persisted, context.snapshots.get(context.boardId)!.state);
      expect(Y.equalSnapshots(Y.snapshot(persisted), Y.snapshot(context.writer.document))).toBe(true);
    } finally { persisted.destroy(); }
    expect(console.warn).not.toHaveBeenCalled();
    expect(DEFAULT_LIMITS.aclCheckTimeoutMs).toBe(3_000);
  }, 10_000);

  it("rejects exactly the 65th held frame with the default bounded queue", async () => {
    const context = await delayedAccess(DEFAULT_LIMITS.maxQueuedMessages);
    const closed = vi.fn();
    context.writer.provider.on("close", () => { closed(); context.writer.websocketProvider.disconnect(); });
    await context.hold();
    // hold() has already enqueued one stateless frame behind the access lookup.
    const baseline = context.forwarded.length;
    const message = new OutgoingMessage(context.boardId).writeStateless("{}").toUint8Array();
    for (let index = 0; index < 63; index += 1) context.writer.websocketProvider.webSocket!.send(message);
    await waitFor(() => context.forwarded.length >= baseline + 63);
    expect(closed).not.toHaveBeenCalled();
    context.writer.websocketProvider.webSocket!.send(message);
    await waitFor(() => closed.mock.calls.length > 0);
    const limits = vi.mocked(console.warn).mock.calls.map(([value]) => JSON.parse(String(value)));
    expect(limits).toContainEqual(expect.objectContaining({ event: "collaboration_receive_limit", kind: "queued-messages", queuedFrames: 64 }));
  });
});
