// @vitest-environment node
import { Buffer } from "node:buffer";

import { OutgoingMessage } from "@hocuspocus/server";
import type { Server } from "@hocuspocus/server";
import WebSocket from "ws";
import * as Y from "yjs";
import { afterEach, describe, expect, it } from "vitest";

import { createCollaborationServer } from "../server";
import type { BoardRole, CollaborationContext, CollaborationLimits, SnapshotRepository, StoredDocument } from "../types";

import { BOARD_ID, ORIGIN, createTestClient, insertRectangle, waitFor } from "./helpers";
import type { TestClient } from "./helpers";

const servers: Server<CollaborationContext>[] = [];
const clients: TestClient[] = [];

async function fixture(limits: Partial<CollaborationLimits> = {}) {
  const documents = new Map<string, StoredDocument>();
  const roles = new Map<string, BoardRole>([["editor", "editor"], ["editor2", "editor"], ["viewer", "viewer"]]);
  let failWrites = false;
  let hangRevalidation = false;
  const repository: SnapshotRepository = {
    async load(boardId) { return documents.get(boardId) ?? null; },
    async save(boardId, state) {
      if (failWrites) throw new Error("Test database is unavailable");
      const saved = { state: new Uint8Array(state), revision: (documents.get(boardId)?.revision ?? 0) + 1, savedAt: new Date() };
      documents.set(boardId, saved);
      return saved;
    },
    async health() { return !failWrites; },
  };
  const server = createCollaborationServer({
    origins: [ORIGIN], port: 0,
    limits: { aclRefreshMs: 50, aclCheckTimeoutMs: 100, persistenceDebounceMs: 20, persistenceMaxDebounceMs: 50, ...limits },
  }, {
    repository,
    async authenticate(headers, boardId) {
      const userId = headers.get("cookie")?.split("=")[1] ?? "";
      const role = roles.get(userId);
      return role && boardId === BOARD_ID ? { boardId, userId, sessionId: userId, name: userId, role } : null;
    },
    async revalidate(principal) {
      if (hangRevalidation) return new Promise<BoardRole | null>(() => undefined);
      return roles.get(principal.userId) ?? null;
    },
  });
  await server.listen();
  servers.push(server);
  const url = `ws://127.0.0.1:${server.address.port}`;
  return {
    server, url, documents, roles,
    setFailure(value: boolean) { failWrites = value; },
    hangAccessChecks() { hangRevalidation = true; },
    async client(user: string) {
      const client = createTestClient(url, user);
      clients.push(client);
      await client.connect();
      return client;
    },
  };
}

afterEach(async () => {
  clients.splice(0).forEach((client) => client.destroy());
  await Promise.all(servers.splice(0).map((server) => server.destroy()));
});

describe("collaboration over real WebSocket connections", () => {
  it("synchronizes two editors and confirms insertions and deletions only after persistence", async () => {
    const context = await fixture();
    const first = await context.client("editor");
    const second = await context.client("editor2");
    insertRectangle(first.document, "rectangle");
    await waitFor(() => second.document.getMap("layers").has("rectangle") && first.isPersisted());
    const previous = first.lastAcknowledgement()!;
    const vector = Buffer.from(Y.encodeStateVector(first.document));
    first.document.transact(() => {
      first.document.getMap("layers").delete("rectangle");
      first.document.getArray("layerIds").delete(0, 1);
    });
    expect(Buffer.from(Y.encodeStateVector(first.document))).toEqual(vector);
    expect(first.isPersisted()).toBe(false);
    await waitFor(() => !second.document.getMap("layers").has("rectangle") && first.isPersisted());
    expect(first.lastAcknowledgement()!.revision).toBeGreaterThan(previous.revision);
    const restored = new Y.Doc();
    Y.applyUpdate(restored, context.documents.get(BOARD_ID)!.state);
    expect(restored.getMap("layers").size).toBe(0);
    restored.destroy();
  });

  it("rejects a viewer who sends a raw CRDT write", async () => {
    const context = await fixture();
    const editor = await context.client("editor");
    insertRectangle(editor.document, "rectangle");
    await waitFor(() => editor.isPersisted());
    const viewer = await context.client("viewer");
    expect(viewer.provider.authorizedScope).toBe("readonly");
    let closed = false;
    viewer.provider.on("close", () => { closed = true; viewer.websocketProvider.disconnect(); });
    viewer.document.getMap<Y.Map<unknown>>("layers").get("rectangle")!.set("x", 999);
    await waitFor(() => closed || !viewer.provider.isAuthenticated);
    expect(editor.document.getMap<Y.Map<unknown>>("layers").get("rectangle")!.get("x")).toBe(0);
  });

  it("disconnects an active editor after access is revoked", async () => {
    const context = await fixture();
    const editor = await context.client("editor");
    let closed = false;
    editor.provider.on("close", () => { closed = true; editor.websocketProvider.disconnect(); });
    context.roles.delete("editor");
    await waitFor(() => closed, 1_000);
    expect(context.server.hocuspocus.getConnectionsCount()).toBe(0);
  });

  it("preserves nested cursor and drag presence and replaces a forged user identity", async () => {
    const context = await fixture();
    const first = await context.client("editor");
    const second = await context.client("editor2");
    first.provider.awareness!.setLocalState({
      user: { id: "forged-owner", name: "Owner" },
      presence: { cursor: { x: 10, y: 20 }, selection: ["rectangle"], drag: { ids: ["rectangle"], delta: { x: 7, y: 8 } } },
    });
    await waitFor(() => {
      const state = second.provider.awareness!.getStates().get(first.document.clientID);
      return state?.presence?.cursor?.x === 10;
    });
    const state = second.provider.awareness!.getStates().get(first.document.clientID)!;
    expect(state.user).toEqual({ id: "editor", name: "editor" });
    expect(state.presence.cursor).toEqual({ x: 10, y: 20 });
    expect(state.presence.drag).toEqual({ ids: ["rectangle"], delta: { x: 7, y: 8 } });
  });

  it("fails closed when the access database stops responding", async () => {
    const context = await fixture();
    const editor = await context.client("editor");
    let closed = false;
    editor.provider.on("close", () => { closed = true; editor.websocketProvider.disconnect(); });
    context.hangAccessChecks();
    await waitFor(() => closed, 500);
    expect(context.server.hocuspocus.getConnectionsCount()).toBe(0);
  });

  it("rejects a forged persistence broadcast from a client", async () => {
    const context = await fixture();
    const attacker = await context.client("editor");
    const observer = await context.client("editor2");
    let closed = false;
    attacker.provider.on("close", () => { closed = true; attacker.websocketProvider.disconnect(); });
    const message = new OutgoingMessage(BOARD_ID).writeBroadcastStateless(JSON.stringify({
      type: "persisted", revision: 999_999, snapshot: "AAA=", savedAt: new Date().toISOString(),
    }));
    attacker.websocketProvider.webSocket!.send(message.toUint8Array());
    await waitFor(() => closed);
    expect(observer.messages.some((value) => value.type === "persisted" && value.revision === 999_999)).toBe(false);
  });

  it("rejects an invalid schema update before it reaches another editor", async () => {
    const context = await fixture();
    const attacker = await context.client("editor");
    const observer = await context.client("editor2");
    let closed = false;
    attacker.provider.on("close", () => { closed = true; attacker.websocketProvider.disconnect(); });
    attacker.document.getMap("meta").set("schemaVersion", 999);
    await waitFor(() => closed);
    expect(observer.document.getMap("meta").get("schemaVersion")).toBe(1);
  });

  it("closes an authenticated frame flood before the processing queue can grow", async () => {
    const context = await fixture({ maxQueuedMessages: 4 });
    const editor = await context.client("editor");
    let closed = false;
    let closeReason = "";
    editor.provider.on("close", ({ event }: { event: { reason?: string } }) => {
      closed = true;
      closeReason = event.reason ?? "";
      editor.websocketProvider.disconnect();
    });
    const frame = new OutgoingMessage(BOARD_ID).writeStateless("{}").toUint8Array();
    for (let index = 0; index < 100; index += 1) editor.websocketProvider.webSocket!.send(frame);
    await waitFor(() => closed, 1_000);
    expect(closeReason).toContain("receive limit");
    expect(context.server.hocuspocus.getConnectionsCount()).toBe(0);
  });

  it("keeps the saved snapshot unchanged during database failure and retries without a new edit", async () => {
    const context = await fixture();
    const editor = await context.client("editor");
    await waitFor(() => editor.isPersisted());
    const savedRevision = editor.lastAcknowledgement()!.revision;
    context.setFailure(true);
    insertRectangle(editor.document, "retry");
    await waitFor(() => editor.messages.some((message) => message.type === "persistence-error"));
    expect(editor.isPersisted()).toBe(false);
    expect(editor.lastAcknowledgement()!.revision).toBe(savedRevision);
    context.setFailure(false);
    await waitFor(() => editor.isPersisted(), 4_000);
    expect(context.documents.get(BOARD_ID)!.revision).toBeGreaterThan(savedRevision);
  });

  it("rejects an untrusted Origin before upgrading the socket", async () => {
    const context = await fixture();
    const socket = new WebSocket(context.url, { headers: { Origin: "https://untrusted.example" } });
    const status = await new Promise<number>((resolve, reject) => {
      socket.once("unexpected-response", (_request, response) => { response.resume(); socket.terminate(); resolve(response.statusCode ?? 0); });
      socket.once("open", () => { socket.close(); reject(new Error("Untrusted socket was accepted")); });
      socket.on("error", () => undefined);
    });
    expect(status).toBe(403);
  });
});
