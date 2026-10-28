// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { HocuspocusProvider, HocuspocusProviderWebsocket, MessageType } from "@hocuspocus/provider";
import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";
import { messageYjsSyncStep2, messageYjsUpdate, readSyncMessage, writeSyncStep1, writeSyncStep2, writeUpdate } from "y-protocols/sync";
import * as Y from "yjs";
import { configureOfflineSync } from "@/lib/collaboration/offline-sync";

const resources: { provider: HocuspocusProvider; transport: HocuspocusProviderWebsocket; doc: Y.Doc }[] = [];

function client(readyState: number | null = null, configure = true) {
  const transport = new HocuspocusProviderWebsocket({ url: "ws://localhost/collaboration", autoConnect: false });
  if (configure) configureOfflineSync(transport);
  const doc = new Y.Doc();
  const provider = new HocuspocusProvider({ name: "board", document: doc, awareness: null, websocketProvider: transport });
  provider.attach();
  const native = { identifier: "test", readyState: readyState ?? 3, send: vi.fn<(message: unknown) => void>(),
    close: vi.fn(), addEventListener: vi.fn(), removeEventListener: vi.fn() };
  function attachNative(): void {
    transport.webSocket = native as unknown as NonNullable<typeof transport.webSocket>;
    transport.attachWebSocketListeners(transport.webSocket, vi.fn());
  }
  if (readyState !== null) attachNative();
  resources.push({ provider, transport, doc });
  return { provider, transport, doc, native, attachNative };
}

function flushQueue(context: ReturnType<typeof client>): void {
  if (!context.transport.webSocket) context.attachNative();
  context.native.readyState = 1;
  context.transport.connectionAttempt = { resolve: vi.fn(), reject: vi.fn() };
  context.transport.resolveConnectionAttempt();
}

function frame(type: number, payload: (encoder: encoding.Encoder) => void = () => {}): Uint8Array {
  const encoder = encoding.createEncoder();
  encoding.writeVarString(encoder, "board");
  encoding.writeVarUint(encoder, type);
  payload(encoder);
  return encoding.toUint8Array(encoder);
}

function syncDecoder(message: Uint8Array): decoding.Decoder {
  const decoder = decoding.createDecoder(message);
  expect(decoding.readVarString(decoder)).toBe("board");
  expect(decoding.readVarUint(decoder)).toBe(MessageType.Sync);
  return decoder;
}

afterEach(() => {
  for (const { provider, transport, doc } of resources.splice(0)) {
    provider.destroy();
    transport.destroy();
    doc.destroy();
  }
});

describe("offline synchronization with the installed Hocuspocus SDK", () => {
  it.each([["absent", null], ["CONNECTING", 0], ["CLOSING", 2], ["CLOSED", 3]] as const)(
    "keeps document changes in Y.Doc without queuing SyncUpdate when the native socket is %s", (_label, readyState) => {
      const context = client(readyState);
      context.doc.getMap("draft").set("offline", "preserved");
      const snapshot = Y.encodeStateAsUpdate(context.doc);
      expect(context.native.send).not.toHaveBeenCalled();
      context.provider.sendStateless("queue marker");
      flushQueue(context);
      expect(context.native.send).toHaveBeenCalledTimes(1);
      expect(context.native.send).toHaveBeenCalledWith(frame(MessageType.Stateless, (encoder) => {
        encoding.writeVarString(encoder, "queue marker");
      }));
      expect(Y.encodeStateAsUpdate(context.doc)).toEqual(snapshot);
      expect(context.provider.synced).toBe(false);
    },
  );

  it("answers the reconnect state vector with every retained offline insertion and deletion", () => {
    const context = client(3);
    const server = new Y.Doc();
    try {
      context.doc.getMap("draft").set("old", "removed offline");
      Y.applyUpdate(server, Y.encodeStateAsUpdate(context.doc));
      context.doc.getMap("draft").delete("old");
      context.doc.getMap("draft").set("new", "retained offline");
      flushQueue(context);
      expect(context.native.send).not.toHaveBeenCalled();
      const step1 = frame(MessageType.Sync, (encoder) => writeSyncStep1(encoder, server));
      context.transport.onMessage({ data: step1 } as MessageEvent);
      expect(context.native.send).toHaveBeenCalledTimes(1);
      const reply = context.native.send.mock.calls[0][0] as Uint8Array;
      expect(decoding.readVarUint(syncDecoder(reply))).toBe(messageYjsSyncStep2);
      readSyncMessage(syncDecoder(reply), encoding.createEncoder(), server, "server");
      expect(server.getMap("draft").toJSON()).toEqual(context.doc.getMap("draft").toJSON());
      expect(Y.encodeStateVector(server)).toEqual(Y.encodeStateVector(context.doc));
    } finally { server.destroy(); }
  });

  it("sends an OPEN edit made after client SyncStep2 while the provider is still unsynced", () => {
    const context = client(1);
    const server = new Y.Doc();
    try {
      const step1 = frame(MessageType.Sync, (encoder) => writeSyncStep1(encoder, server));
      context.provider.onMessage({ data: step1 } as MessageEvent);
      expect(context.provider.synced).toBe(false);
      context.doc.getMap("draft").set("after-step2", "must reach the server");
      expect(context.native.send).toHaveBeenCalledTimes(2);
      const messages = context.native.send.mock.calls.map(([message]) => message as Uint8Array);
      expect(messages.map((message) => decoding.readVarUint(syncDecoder(message)))).toEqual([
        messageYjsSyncStep2, messageYjsUpdate,
      ]);
      for (const message of messages) readSyncMessage(syncDecoder(message), encoding.createEncoder(), server, "server");
      expect(server.getMap("draft").get("after-step2")).toBe("must reach the server");
      expect(context.provider.synced).toBe(false);
    } finally { server.destroy(); }
  });

  it("installs once on a single instance and leaves another SDK transport's behavior intact", () => {
    const prototypeSend = HocuspocusProviderWebsocket.prototype.send;
    const configured = client();
    const original = client(null, false);
    const adapter = configured.transport.send;
    configureOfflineSync(configured.transport);
    expect(configured.transport.send).toBe(adapter);
    expect(original.transport.send).toBe(prototypeSend);
    expect(HocuspocusProviderWebsocket.prototype.send).toBe(prototypeSend);
    configured.doc.getMap("draft").set("id", "configured");
    original.doc.getMap("draft").set("id", "original");
    flushQueue(configured);
    flushQueue(original);
    expect(configured.native.send).not.toHaveBeenCalled();
    expect(original.native.send).toHaveBeenCalledTimes(1);
    expect(decoding.readVarUint(syncDecoder(original.native.send.mock.calls[0][0] as Uint8Array))).toBe(messageYjsUpdate);
  });

  it("preserves the original send receiver and return value", () => {
    const context = client(null, false);
    const result = Symbol("send result");
    const send = vi.fn(function (this: HocuspocusProviderWebsocket) {
      expect(this).toBe(context.transport);
      return result;
    });
    context.transport.send = send;
    configureOfflineSync(context.transport);
    expect(context.transport.send("passthrough")).toBe(result);
    expect(send).toHaveBeenCalledWith("passthrough");
  });
});

describe("offline control and unrecognized frame passthrough", () => {
  const doc = new Y.Doc();
  const update = frame(MessageType.Sync, (encoder) => writeUpdate(encoder, Y.encodeStateAsUpdate(doc)));
  const frames: [string, unknown][] = [
    ["Auth", frame(MessageType.Auth, (encoder) => {
      encoding.writeVarUint(encoder, 0);
      encoding.writeVarString(encoder, "token");
    })],
    ["Awareness", frame(MessageType.Awareness, (encoder) => encoding.writeVarUint8Array(encoder, new Uint8Array([0])))],
    ["QueryAwareness", frame(MessageType.QueryAwareness)],
    ["SyncStep1", frame(MessageType.Sync, (encoder) => writeSyncStep1(encoder, doc))],
    ["SyncStep2", frame(MessageType.Sync, (encoder) => writeSyncStep2(encoder, doc))],
    ["Stateless", frame(MessageType.Stateless, (encoder) => encoding.writeVarString(encoder, "status"))],
    ["Close", frame(MessageType.CLOSE, (encoder) => encoding.writeVarString(encoder, "closed"))],
    ["SyncStatus", frame(MessageType.SyncStatus, (encoder) => encoding.writeVarInt(encoder, 1))],
    ["Ping", new Uint8Array([MessageType.Ping])],
    ["Pong", new Uint8Array([MessageType.Pong])],
    ["unknown message", frame(255)],
    ["unknown sync subtype", frame(MessageType.Sync, (encoder) => encoding.writeVarUint(encoder, 255))],
    ["empty", new Uint8Array()],
    ["truncated varint", new Uint8Array([128])],
    ["truncated document name", new Uint8Array([5, 1])],
    ["missing sync subtype", frame(MessageType.Sync)],
    ["truncated update payload", update.slice(0, -1)],
    ["truncated payload view over a complete buffer", update.subarray(0, -1)],
    ["update with trailing data", new Uint8Array([...update, 0])],
    ["nonbinary value", "unknown"],
  ];
  doc.destroy();

  it.each(frames)("keeps the SDK's queue and wire behavior for %s", (_label, message) => {
    const context = client(0);
    context.transport.send(message);
    expect(context.native.send).not.toHaveBeenCalled();
    flushQueue(context);
    expect(context.native.send).toHaveBeenCalledExactlyOnceWith(message);
  });
});
