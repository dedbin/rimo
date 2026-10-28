// @vitest-environment node
import { randomUUID } from "node:crypto";

import { HocuspocusProvider, HocuspocusProviderWebsocket } from "@hocuspocus/provider";
import { IncomingMessage, MessageType, OutgoingMessage } from "@hocuspocus/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import * as Y from "yjs";

import { ReceiveGuard } from "../receive-guard";
import { AUTH_CONTROL_BYTES } from "../receive-transport";
import { DEFAULT_LIMITS } from "../types";
import { insertRectangle, ORIGIN, waitFor } from "./helpers";
import { authenticationFrame, cleanupIngress, closeIngressSocket, ingressBarrier, ingressFixture } from "./ingress-fixture";

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(cleanupIngress);

function largeFrame(boardId: string): Uint8Array {
  return new OutgoingMessage(boardId).writeStateless("x".repeat(DEFAULT_LIMITS.maxPayloadBytes - 64)).toUint8Array();
}

function largeForwarded(frames: Uint8Array[]): Uint8Array[] {
  return frames.filter((frame) => frame.byteLength > DEFAULT_LIMITS.maxPayloadBytes - 100);
}

async function expectNormalWriter(context: Awaited<ReturnType<typeof ingressFixture>>): Promise<void> {
  const writer = context.provider(randomUUID());
  await writer.connect();
  insertRectangle(writer.document, "after-cleanup");
  await waitFor(() => writer.isPersisted());
  expect(context.server.hocuspocus.documents.get(writer.provider.configuration.name)?.getMap("layers").has("after-cleanup")).toBe(true);
}

describe("early SDK ingress over real WebSocket connections", () => {
  it("enforces the unchanged 32 MiB aggregate before authentication completes", async () => {
    const auth = ingressBarrier();
    let started = 0;
    const context = await ingressFixture((dependencies) => {
      const authenticate = dependencies.authenticate;
      dependencies.authenticate = async (...args) => { started += 1; await auth.waiting; return authenticate(...args); };
    });
    const board = randomUUID();
    const frame = largeFrame(board);
    const peers: Awaited<ReturnType<typeof context.raw>>[] = [];
    for (let index = 0; index < 6; index += 1) {
      const peer = await context.raw(board);
      peers.push(peer);
      await waitFor(() => started === index + 1);
      peer.socket.send(frame);
      await waitFor(() => largeForwarded(context.forwarded).length === Math.min(index + 1, 5) || peer.closeCode() !== 0);
    }
    await waitFor(() => peers[5].closeCode() !== 0);
    expect(peers[5].closeCode()).toBe(1008);
    expect(largeForwarded(context.forwarded)).toHaveLength(5);
    expect(context.server.hocuspocus.documents.size).toBe(0);
    const event = vi.mocked(console.warn).mock.calls.map(([value]) => JSON.parse(String(value))).find((entry) => entry.kind === "total-bytes");
    expect(event).toEqual({ event: "collaboration_receive_limit", kind: "total-bytes", queuedFrames: 0,
      queuedBytes: 0, totalQueuedBytes: 5 * frame.byteLength + 6 * authenticationFrame(board).byteLength, incomingBytes: frame.byteLength });
    expect(JSON.stringify(event)).not.toContain(board);
    auth.release();
    await waitFor(() => context.server.hocuspocus.getConnectionsCount() === 5);
    await Promise.all(peers.map((peer) => closeIngressSocket(peer.socket)));
    await expectNormalWriter(context);
  });

  it("bounds frames during load and returns pre-auth bytes only after SDK handleClose clears them", async () => {
    const loading = ingressBarrier();
    let started = false;
    const context = await ingressFixture((dependencies) => {
      const load = dependencies.repository.load;
      dependencies.repository.load = async (id) => { started = true; await loading.waiting; return load(id); };
    });
    const board = randomUUID();
    const frame = largeFrame(board);
    const peers: Awaited<ReturnType<typeof context.raw>>[] = [];
    for (let index = 0; index < 6; index += 1) {
      const peer = await context.raw(board);
      peers.push(peer);
      await waitFor(() => started);
      peer.socket.send(frame);
      await waitFor(() => largeForwarded(context.forwarded).length === Math.min(index + 1, 5) || peer.closeCode() !== 0);
    }
    await waitFor(() => peers[5].closeCode() !== 0);
    expect(peers[5].closeCode()).toBe(1008);
    expect(largeForwarded(context.forwarded)).toHaveLength(5);
    expect(context.server.hocuspocus.getConnectionsCount()).toBe(0);
    await closeIngressSocket(peers[0].socket);
    const replacement = await context.raw(board);
    replacement.socket.send(frame);
    await waitFor(() => largeForwarded(context.forwarded).length === 6 || replacement.closeCode() !== 0);
    expect(replacement.socket.readyState).toBe(WebSocket.OPEN);
    loading.release();
    await waitFor(() => context.server.hocuspocus.getConnectionsCount() === 5);
    await Promise.all([...peers, replacement].map((peer) => closeIngressSocket(peer.socket)));
    await expectNormalWriter(context);
  });

  it.each(["authenticate", "load"] as const)("clears failed %s queues and admits a new writer", async (stage) => {
    const blocked = ingressBarrier();
    let started = false;
    let fail = true;
    const context = await ingressFixture((dependencies) => {
      if (stage === "authenticate") {
        const authenticate = dependencies.authenticate;
        dependencies.authenticate = async (...args) => {
          if (fail) { started = true; await blocked.waiting; return null; }
          return authenticate(...args);
        };
      } else {
        const load = dependencies.repository.load;
        dependencies.repository.load = async (id) => {
          if (fail) { started = true; await blocked.waiting; throw new Error("Fixture load failure"); }
          return load(id);
        };
      }
    }, { maxConnections: 1 });
    const board = randomUUID();
    const peer = await context.raw(board);
    await waitFor(() => started);
    peer.socket.send(largeFrame(board));
    await waitFor(() => largeForwarded(context.forwarded).length === 1);
    blocked.release();
    await waitFor(() => peer.closeCode() !== 0);
    expect(peer.closeCode()).toBe(1008);
    await waitFor(() => context.server.hocuspocus.loadingDocuments.size === 0);
    expect(context.server.hocuspocus.documents.size).toBe(0);
    fail = false;
    await expectNormalWriter(context);
  });

  it("retains a closed pending Auth slot until the authentication continuation finishes", async () => {
    const auth = ingressBarrier();
    let started = false;
    const context = await ingressFixture((dependencies) => {
      const authenticate = dependencies.authenticate;
      dependencies.authenticate = async (...args) => { started = true; await auth.waiting; return authenticate(...args); };
    }, { maxConnections: 1 });
    const first = await context.raw(randomUUID());
    await waitFor(() => started);
    await closeIngressSocket(first.socket);
    const excess = await context.raw(randomUUID());
    await waitFor(() => excess.closeCode() !== 0);
    expect(excess.closeReason()).toBe("Server receive connection limit reached");
    auth.release();
    await waitFor(() => vi.mocked(console.error).mock.calls.some(([message]) => String(message) === "[onAuthenticate]"));
    await expectNormalWriter(context);
  });

  it("bounds the initial cookie Auth control frame and releases malformed handshakes", async () => {
    const context = await ingressFixture(undefined, { maxConnections: 1 });
    const board = randomUUID();
    const huge = await context.raw(board, false);
    huge.socket.send(authenticationFrame(board, "v".repeat(AUTH_CONTROL_BYTES)));
    await waitFor(() => huge.closeCode() !== 0);
    expect(huge.closeReason()).toBe("Authentication frame limit reached");
    const malformed = await context.raw(board, false);
    const frame = authenticationFrame(board);
    malformed.socket.send(frame.subarray(0, frame.length - 1));
    await waitFor(() => malformed.closeCode() !== 0);
    expect(malformed.closeCode()).toBe(1008);
    const inherited = await context.raw("__proto__", false);
    inherited.socket.send(authenticationFrame("__proto__"));
    await waitFor(() => inherited.closeCode() !== 0);
    expect(inherited.closeCode()).toBe(1008);
    expect(context.forwarded).toHaveLength(0);
    await expectNormalWriter(context);
  });

  it("preserves provider authenticationFailed for a bounded incorrect token", async () => {
    let authenticated = 0;
    const context = await ingressFixture((dependencies) => {
      const authenticate = dependencies.authenticate;
      dependencies.authenticate = async (...args) => { authenticated += 1; return authenticate(...args); };
    }, { maxConnections: 1 });
    const document = new Y.Doc();
    const transport = new HocuspocusProviderWebsocket({ url: `ws://127.0.0.1:${context.server.address.port}`,
      autoConnect: false, maxAttempts: 1, jitter: false, initialDelay: 0,
      WebSocketPolyfill: class extends WebSocket {
        constructor(url: string) { super(url, { headers: { Origin: ORIGIN } }); }
      } });
    let reason = "";
    const provider = new HocuspocusProvider({ name: randomUUID(), document, token: "wrong",
      sessionAwareness: true, websocketProvider: transport,
      onAuthenticationFailed(event) { reason = event.reason; transport.shouldConnect = false; } });
    provider.attach();
    try {
      const connected = transport.connect().catch(() => undefined);
      await waitFor(() => !!reason);
      expect(provider.effectiveName).toContain("\0");
      expect(reason).toBe("Authentication required");
      expect(authenticated).toBe(0);
      expect(context.forwarded).toHaveLength(0);
      await connected;
      await waitFor(() => transport.status === "disconnected");
    } finally { provider.destroy(); transport.destroy(); document.destroy(); }
    await expectNormalWriter(context);
  });

  it("never reuses a pending plain-name budget for a session Auth, including after 50 retries", async () => {
    const context = await ingressFixture();
    const board = randomUUID();
    for (let index = 0; index < DEFAULT_LIMITS.maxConnections; index += 1) {
      const peer = await context.raw(board, false);
      const before = context.forwarded.length;
      peer.socket.send(new OutgoingMessage(board).writeStateless("pending").toUint8Array());
      await waitFor(() => context.forwarded.length === before + 1);
      peer.socket.send(authenticationFrame(`${board}\0session-${index}`));
      await waitFor(() => peer.closeCode() !== 0);
      expect(peer.closeReason()).toBe("Pending connection limit reached");
      expect(context.forwarded).toHaveLength(before + 1);
    }
    await expectNormalWriter(context);
  }, 15_000);

  it("releases Auth setup abandoned by the SDK's smaller unauthenticated message cap", async () => {
    const context = await ingressFixture(undefined, { maxConnections: 1 });
    const board = randomUUID();
    const peer = await context.raw(board, false);
    const frame = new OutgoingMessage(board).writeStateless("q").toUint8Array();
    // Public IncomingMessage.socket exposes the client transport: one corked WS batch.
    peer.nativeSocket().cork();
    peer.socket.send(authenticationFrame(board));
    for (let index = 0; index < 21; index += 1) peer.socket.send(frame);
    peer.nativeSocket().uncork();
    await waitFor(() => peer.closeCode() !== 0);
    expect(vi.mocked(console.warn).mock.calls.some(([message]) => String(message).includes("unauthenticated message queue length"))).toBe(true);
    expect(context.server.hocuspocus.documents.size).toBe(0);
    await expectNormalWriter(context);
  });

  it("charges an attached legacy connection before an exact session still authenticating", async () => {
    const loading = ingressBarrier();
    const auth = ingressBarrier();
    const processed = vi.spyOn(ReceiveGuard.prototype, "processed");
    const board = randomUUID();
    let loadStarted = false;
    let authStarted = false;
    let calls = 0;
    const context = await ingressFixture((dependencies) => {
      const authenticate = dependencies.authenticate;
      const load = dependencies.repository.load;
      dependencies.authenticate = async (...args) => {
        if (++calls === 2) { authStarted = true; await auth.waiting; }
        return authenticate(...args);
      };
      dependencies.repository.load = async (id) => {
        if (id === board) { loadStarted = true; await loading.waiting; }
        return load(id);
      };
    });
    const peer = await context.raw(board);
    await expect.poll(() => loadStarted, { timeout: 1_500, message: "legacy load started" }).toBe(true);
    const session = `${board}\0session`;
    peer.socket.send(authenticationFrame(session));
    await expect.poll(() => authStarted, { timeout: 1_500, message: "session authentication started" }).toBe(true);
    loading.release();
    await expect.poll(() => context.server.hocuspocus.getConnectionsCount(), { timeout: 1_500, message: "legacy attached" }).toBe(1);
    peer.socket.send(largeFrame(session));
    await expect.poll(() => processed.mock.calls.some(([, update]) => update.byteLength > DEFAULT_LIMITS.maxPayloadBytes - 100),
      { timeout: 1_500, message: "legacy processed session-addressed frame" }).toBe(true);
    peer.socket.send(new OutgoingMessage(session).writeStateless("q").toUint8Array());
    await expect.poll(() => processed.mock.calls.length === 2 || peer.closeCode() !== 0,
      { timeout: 1_500, message: "legacy processed small session-addressed frame" }).toBe(true);
    expect(peer.socket.readyState).toBe(WebSocket.OPEN);
    expect(processed).toHaveBeenCalledTimes(2);
    expect(console.warn).not.toHaveBeenCalled();
    auth.release();
    await expect.poll(() => context.server.hocuspocus.documents.get(board)?.getConnectionsCount(),
      { timeout: 1_500, message: "session attached" }).toBe(2);
    await closeIngressSocket(peer.socket);
    await expectNormalWriter(context);
  });

  it("admits 50 normal connections in five rooms with ten editors", async () => {
    const context = await ingressFixture();
    for (let room = 0; room < 5; room += 1) {
      const board = randomUUID();
      for (let index = 0; index < 10; index += 1) {
        await context.provider(board, index < 2 ? "writer" : "viewer").connect();
      }
    }
    expect(context.server.hocuspocus.getConnectionsCount()).toBe(50);
    expect(context.server.hocuspocus.documents.size).toBe(5);
    expect(console.warn).not.toHaveBeenCalled();
  });

  it("keeps the exact pre-auth Uint8Array when the SDK drains it", async () => {
    const auth = ingressBarrier();
    const processed: Uint8Array[] = [];
    const context = await ingressFixture((dependencies) => {
      const authenticate = dependencies.authenticate;
      dependencies.authenticate = async (...args) => { await auth.waiting; return authenticate(...args); };
    });
    context.server.hocuspocus.configuration.extensions.push({
      async afterHandleMessage(payload) { processed.push(payload.update); },
    });
    const board = randomUUID();
    const peer = await context.raw(board);
    peer.socket.send(new OutgoingMessage(board).writeStateless("identity").toUint8Array());
    await waitFor(() => context.forwarded.length === 2);
    const accepted = context.forwarded[1];
    const message = new IncomingMessage(accepted);
    message.readVarString();
    expect(message.readVarUint()).toBe(MessageType.Stateless);
    auth.release();
    await waitFor(() => processed.length === 1);
    expect(processed[0]).toBe(accepted);
  });
});
