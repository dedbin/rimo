// @vitest-environment node
import { Connection, Document, OutgoingMessage } from "@hocuspocus/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ReceiveGuard } from "../receive-guard";
import { DEFAULT_LIMITS } from "../types";
import type { CollaborationContext, CollaborationLimits } from "../types";

const guards: ReceiveGuard[] = [];

function fixture(limits: Partial<CollaborationLimits> = {}) {
  const reject = vi.fn<(reservationId: string) => void>();
  const guard = new ReceiveGuard({ ...DEFAULT_LIMITS, ...limits }, reject);
  guards.push(guard);
  const attach = (id: string) => {
    const callbacks: (() => void)[] = [];
    const delivered = vi.fn<(update: Uint8Array) => void>();
    const connection = {
      context: { reservationId: id, boardId: "board" },
      handleMessage: delivered as (update: Uint8Array) => void,
      onClose(callback: () => void): void { callbacks.push(callback); },
      close: vi.fn(() => { for (const callback of callbacks) callback(); }),
      webSocket: { close: vi.fn() },
    };
    guard.attach(connection as unknown as Connection<CollaborationContext>);
    return { connection, delivered };
  };
  return { guard, reject, attach };
}

beforeEach(() => { vi.spyOn(console, "warn").mockImplementation(() => undefined); });

afterEach(() => {
  guards.splice(0).forEach((guard) => guard.stop());
  vi.restoreAllMocks();
});

describe("aggregate collaboration receive budget", () => {
  it("preserves the production limits", () => {
    expect(DEFAULT_LIMITS).toMatchObject({ maxConnections: 50, maxQueuedMessages: 64,
      maxPayloadBytes: 6 * 1024 * 1024, maxQueuedBytes: 6 * 1024 * 1024, maxTotalQueuedBytes: 32 * 1024 * 1024,
      maxMessagesPerSecond: 120, maxBytesPerSecond: 2 * 1024 * 1024 });
  });

  it("allows five maximum-size frames and rejects a sixth across different connections", () => {
    const { attach, reject } = fixture();
    for (let index = 0; index < 5; index += 1) {
      const writer = attach(`writer-${index}`);
      const frame = new Uint8Array(DEFAULT_LIMITS.maxPayloadBytes);
      writer.connection.handleMessage(frame);
      expect(writer.delivered).toHaveBeenCalledOnce();
      expect(writer.delivered.mock.calls[0]?.[0]).toBe(frame);
      expect(writer.connection.close).not.toHaveBeenCalled();
    }
    const excess = attach("excess");
    excess.connection.handleMessage(new Uint8Array(DEFAULT_LIMITS.maxPayloadBytes));
    expect(excess.delivered).not.toHaveBeenCalled();
    expect(reject).toHaveBeenCalledExactlyOnceWith("excess");
    expect(excess.connection.close).toHaveBeenCalledWith({ code: 1008, reason: "Connection receive limit reached" });
    expect(excess.connection.webSocket.close).toHaveBeenCalledWith(1008, "Connection receive limit reached");
  });

  it("counts only accepted frames when the aggregate limit crosses several connections", () => {
    const { attach, reject } = fixture({ maxTotalQueuedBytes: 10 });
    attach("first").connection.handleMessage(new Uint8Array(4));
    attach("second").connection.handleMessage(new Uint8Array(4));
    const excess = attach("excess");
    excess.connection.handleMessage(new Uint8Array(3));
    const remaining = attach("remaining");
    remaining.connection.handleMessage(new Uint8Array(2));
    expect(excess.delivered).not.toHaveBeenCalled();
    expect(remaining.delivered).toHaveBeenCalledOnce();
    expect(reject).toHaveBeenCalledExactlyOnceWith("excess");
  });

  it("does not grant duplicate credit for processed or unrelated frames", () => {
    const { guard, attach, reject } = fixture({ maxTotalQueuedBytes: 8 });
    const first = attach("first"), second = attach("second");
    const frame = new Uint8Array(4);
    first.connection.handleMessage(frame);
    second.connection.handleMessage(new Uint8Array(4));
    guard.processed("first", frame);
    guard.processed("first", frame);
    guard.processed("second", new Uint8Array(4));
    guard.processed("unknown", frame);
    const next = attach("next");
    next.connection.handleMessage(new Uint8Array(4));
    const excess = attach("excess");
    excess.connection.handleMessage(new Uint8Array(1));
    expect(next.delivered).toHaveBeenCalledOnce();
    expect(excess.delivered).not.toHaveBeenCalled();
    expect(reject).toHaveBeenCalledExactlyOnceWith("excess");
  });

  it("does not grant duplicate credit for repeated release or late processing", () => {
    const { guard, attach, reject } = fixture({ maxTotalQueuedBytes: 8 });
    const first = attach("first"), second = attach("second");
    const frame = new Uint8Array(4);
    first.connection.handleMessage(frame);
    second.connection.handleMessage(new Uint8Array(4));
    guard.release("first");
    guard.release("first");
    guard.processed("first", frame);
    const next = attach("next");
    next.connection.handleMessage(new Uint8Array(4));
    const excess = attach("excess");
    excess.connection.handleMessage(new Uint8Array(1));
    expect(next.delivered).toHaveBeenCalledOnce();
    expect(excess.delivered).not.toHaveBeenCalled();
    expect(reject).toHaveBeenCalledExactlyOnceWith("excess");
  });

  it("retains bytes after logical close and accepts a new writer only after release", () => {
    const { guard, attach, reject } = fixture({ maxTotalQueuedBytes: 8 });
    const first = attach("first");
    first.connection.handleMessage(new Uint8Array(4));
    attach("second").connection.handleMessage(new Uint8Array(4));
    first.connection.close();
    first.connection.handleMessage(new Uint8Array(1));
    const excess = attach("excess");
    excess.connection.handleMessage(new Uint8Array(1));
    expect(first.delivered).toHaveBeenCalledOnce();
    expect(excess.delivered).not.toHaveBeenCalled();
    expect(reject).toHaveBeenCalledExactlyOnceWith("excess");
    guard.release("first");
    const next = attach("next");
    next.connection.handleMessage(new Uint8Array(4));
    expect(next.delivered).toHaveBeenCalledOnce();
    expect(next.connection.close).not.toHaveBeenCalled();
  });

  it("retains a closed admission slot until release even after its last frame was processed", () => {
    const { guard, attach } = fixture({ maxConnections: 2, maxTotalQueuedBytes: 8 });
    const first = attach("first");
    const frame = new Uint8Array(4);
    first.connection.handleMessage(frame);
    attach("second");
    first.connection.close();
    expect(() => attach("before-drain")).toThrow("Server receive connection limit reached");
    guard.processed("first", frame);
    expect(() => attach("before-disconnect")).toThrow("Server receive connection limit reached");
    guard.release("first");
    const next = attach("next");
    next.connection.handleMessage(new Uint8Array(4));
    expect(next.delivered).toHaveBeenCalledOnce();
  });

  it("holds a real SDK connection budget while close waits for pending message processing", async () => {
    const { guard, attach, reject } = fixture({ maxConnections: 1, maxTotalQueuedBytes: 1_024 });
    const document = new Document("board");
    const socket = { readyState: 1, send: vi.fn(), close: vi.fn() };
    const context: CollaborationContext = { reservationId: "sdk", boardId: "board", userId: "writer",
      sessionId: "fixture", name: "Fixture", role: "editor" };
    const connection = new Connection(socket, new Request("http://localhost"), document, "socket", context);
    let resume: () => void = () => undefined;
    const pending = new Promise<void>((resolve) => { resume = resolve; });
    connection.beforeHandleMessage(async () => { await pending; });
    connection.afterHandleMessage(async (_connection, update) => { guard.processed("sdk", update); });
    guard.attach(connection);
    const drained = new Promise<void>((resolve) => {
      connection.onClose(async () => {
        await connection.waitForPendingMessages();
        guard.release("sdk");
        resolve();
      });
    });
    try {
      connection.handleMessage(new OutgoingMessage("board").writeStateless("fixture").toUint8Array());
      connection.close();
      expect(document.hasConnection(connection)).toBe(false);
      expect(() => attach("before-drain")).toThrow("Server receive connection limit reached");
      resume();
      await drained;
      const next = attach("next");
      next.connection.handleMessage(new Uint8Array(1));
      expect(next.delivered).toHaveBeenCalledOnce();
      expect(reject).not.toHaveBeenCalled();
    } finally {
      resume();
      await connection.waitForPendingMessages();
      document.destroy();
    }
  });

  it("keeps a duplicate reservation from replacing its original budget", () => {
    const { guard, attach } = fixture({ maxTotalQueuedBytes: 8 });
    const first = attach("first");
    first.connection.handleMessage(new Uint8Array(4));
    guard.attach(first.connection as unknown as Connection<CollaborationContext>);
    expect(() => attach("first")).toThrow("Connection receive reservation expired");
    const next = attach("next");
    next.connection.handleMessage(new Uint8Array(4));
    const excess = attach("excess");
    excess.connection.handleMessage(new Uint8Array(1));
    expect(first.delivered).toHaveBeenCalledOnce();
    expect(next.delivered).toHaveBeenCalledOnce();
    expect(excess.delivered).not.toHaveBeenCalled();
  });

  it("rejects a reused pending buffer rather than overwriting its accounting", () => {
    const { guard, attach } = fixture({ maxTotalQueuedBytes: 8 });
    const first = attach("first");
    const frame = new Uint8Array(4);
    first.connection.handleMessage(frame);
    first.connection.handleMessage(frame);
    expect(first.delivered).toHaveBeenCalledOnce();
    expect(first.connection.close).toHaveBeenCalledOnce();
    guard.processed("first", frame);
    guard.processed("first", frame);
    const next = attach("next");
    next.connection.handleMessage(new Uint8Array(8));
    expect(next.delivered).toHaveBeenCalledOnce();
  });

  it("reports queue pressure without identities or payloads", () => {
    const { attach } = fixture();
    const writer = attach("PRIVATE_RESERVATION");
    for (let index = 0; index < 65; index += 1) writer.connection.handleMessage(new Uint8Array(1));
    expect(console.warn).toHaveBeenCalledOnce();
    expect(JSON.parse(String(vi.mocked(console.warn).mock.calls[0][0]))).toEqual({
      event: "collaboration_receive_limit", kind: "queued-messages", queuedFrames: 64,
      queuedBytes: 64, totalQueuedBytes: 64, incomingBytes: 1,
    });
    expect(String(vi.mocked(console.warn).mock.calls[0][0])).not.toContain("PRIVATE");
  });

  it.each(["queued-bytes", "byte-rate", "message-rate", "admission"] as const)("identifies the unchanged %s limit", (kind) => {
    vi.spyOn(Date, "now").mockReturnValue(0);
    const { guard, attach } = fixture();
    const writer = attach("writer");
    if (kind === "admission") {
      for (let index = 1; index < 50; index += 1) attach(`writer-${index}`);
      expect(() => attach("excess")).toThrow("Server receive connection limit reached");
    } else if (kind === "message-rate") {
      for (let index = 0; index < 121; index += 1) {
        const frame = new Uint8Array(1);
        writer.connection.handleMessage(frame);
        guard.processed("writer", frame);
      }
    } else {
      const frame = new Uint8Array(DEFAULT_LIMITS.maxPayloadBytes);
      writer.connection.handleMessage(frame);
      if (kind === "byte-rate") guard.processed("writer", frame);
      writer.connection.handleMessage(new Uint8Array(1));
    }
    expect(console.warn).toHaveBeenCalledOnce();
    const event = JSON.parse(String(vi.mocked(console.warn).mock.calls[0][0]));
    expect(event.kind).toBe(kind);
    for (const key of ["queuedFrames", "queuedBytes", "totalQueuedBytes", "incomingBytes"]) expect(typeof event[key]).toBe("number");
  });
});
