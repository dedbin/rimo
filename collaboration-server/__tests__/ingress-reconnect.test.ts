// @vitest-environment node
import { randomUUID } from "node:crypto";

import { IncomingMessage, MessageType } from "@hocuspocus/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";

import { initializeDocument, validateDocument } from "../document";
import { DEFAULT_LIMITS } from "../types";
import { insertRectangle, waitFor } from "./helpers";
import { cleanupIngress, ingressBarrier, ingressFixture } from "./ingress-fixture";

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(cleanupIngress);

function largeValidBoard(document: Y.Doc): Uint8Array {
  document.transact(() => {
    initializeDocument(document);
    const value = "x".repeat(99_000);
    for (let index = 0; index < 52; index += 1) {
      const id = `cached-${index}`;
      insertRectangle(document, id, index);
      document.getMap<Y.Map<unknown>>("layers").get(id)!.set("value", value);
    }
  });
  const state = validateDocument(document, DEFAULT_LIMITS);
  expect(state.byteLength).toBeGreaterThan(DEFAULT_LIMITS.maxDocumentBytes - 128 * 1024);
  expect(state.byteLength).toBeLessThan(DEFAULT_LIMITS.maxDocumentBytes);
  return state;
}

function syncType(update: Uint8Array): number {
  const message = new IncomingMessage(update);
  message.readVarString();
  expect(message.readVarUint()).toBe(MessageType.Sync);
  return message.readVarUint();
}

describe("large cached and offline documents through early ingress", () => {
  it("accepts a cached near-5 MiB valid board through the normal provider SyncStep2", async () => {
    const loading = ingressBarrier();
    let started = false;
    const context = await ingressFixture((dependencies) => {
      const load = dependencies.repository.load;
      dependencies.repository.load = async (id) => { started = true; await loading.waiting; return load(id); };
    });
    const source = new Y.Doc();
    const state = largeValidBoard(source);
    source.destroy();
    const board = randomUUID();
    const client = context.provider(board);
    // Restore a cache without creating a new outgoing edit before the handshake.
    Y.applyUpdate(client.document, state, client.provider);
    const connected = client.connect();
    await waitFor(() => started && client.provider.isAuthenticated);
    expect(context.forwarded.every((frame) => frame.byteLength < 16 * 1024)).toBe(true);
    loading.release();
    await connected;
    await waitFor(() => client.isPersisted());
    const large = context.forwarded.filter((frame) => frame.byteLength > DEFAULT_LIMITS.maxDocumentBytes - 128 * 1024);
    expect(large).toHaveLength(1);
    expect(syncType(large[0])).toBe(1); // SyncStep2 follows the server's SyncStep1.
    expect(context.server.hocuspocus.documents.get(board)?.getMap("layers").size).toBe(52);
    expect(console.warn).not.toHaveBeenCalled();
  }, 15_000);

  it("converges and saves a near-5 MiB offline draft with the application's normal reconnect transport", async () => {
    const loading = ingressBarrier();
    let block = false;
    let started = false;
    const context = await ingressFixture((dependencies) => {
      const load = dependencies.repository.load;
      dependencies.repository.load = async (id) => {
        if (block) { started = true; await loading.waiting; }
        return load(id);
      };
    });
    const board = randomUUID();
    const client = context.provider(board);
    await client.connect();
    await waitFor(() => client.isPersisted());
    client.websocketProvider.shouldConnect = false;
    const socket = client.websocketProvider.webSocket!;
    socket.close();
    await waitFor(() => socket.readyState === 3 && !context.server.hocuspocus.documents.has(board));
    const state = largeValidBoard(client.document);
    block = true;
    const connected = client.connect();
    await waitFor(() => started && client.provider.isAuthenticated);
    expect(context.forwarded.some((frame) => frame.byteLength >= state.byteLength)).toBe(false);
    expect(client.provider.isSynced).toBe(false);
    loading.release();
    await connected;
    await waitFor(() => client.isPersisted());
    const large = context.forwarded.filter((frame) => frame.byteLength >= state.byteLength);
    expect(large).toHaveLength(1);
    expect(syncType(large[0])).toBe(1);
    expect(context.server.hocuspocus.documents.get(board)?.getMap("layers").size).toBe(52);
    expect(console.warn).not.toHaveBeenCalled();
  }, 15_000);

  it("records the bare SDK offline replay plus duplicate SyncStep2 hitting the unchanged byte-rate limit", async () => {
    const loading = ingressBarrier();
    let block = false;
    let started = false;
    const context = await ingressFixture((dependencies) => {
      const load = dependencies.repository.load;
      dependencies.repository.load = async (id) => {
        if (block) { started = true; await loading.waiting; }
        return load(id);
      };
    });
    const board = randomUUID();
    const client = context.provider(board, "writer", false);
    await client.connect();
    await waitFor(() => client.isPersisted());
    client.websocketProvider.shouldConnect = false;
    const socket = client.websocketProvider.webSocket!;
    socket.close();
    await waitFor(() => socket.readyState === 3 && !context.server.hocuspocus.documents.has(board));
    const state = largeValidBoard(client.document);
    let largeAttempts = 0;
    const send = client.websocketProvider.send;
    client.websocketProvider.send = function (message: unknown): void {
      if (message instanceof Uint8Array && message.byteLength >= state.byteLength) largeAttempts += 1;
      send.call(this, message);
    };
    block = true;
    const connected = client.connect();
    await waitFor(() => started && context.forwarded.some((frame) => frame.byteLength >= state.byteLength));
    client.websocketProvider.shouldConnect = false;
    expect(syncType(context.forwarded.find((frame) => frame.byteLength >= state.byteLength)!)).toBe(2);
    loading.release();
    await connected;
    await waitFor(() => vi.mocked(console.warn).mock.calls.some(([value]) => String(value).includes('"kind":"byte-rate"')));
    expect(largeAttempts).toBe(2);
    expect(context.forwarded.filter((frame) => frame.byteLength >= state.byteLength)).toHaveLength(1);
  }, 15_000);
});
