// @vitest-environment node
import { Buffer } from "node:buffer";

import { OutgoingMessage } from "@hocuspocus/server";
import type { Server } from "@hocuspocus/server";
import WebSocket from "ws";
import * as Y from "yjs";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createLayer } from "../../lib/board/model";
import { BoardRuntime } from "../../lib/collaboration/runtime";
import { LayerType } from "../../types/board-canvas";
import type { BoardSession } from "../../types/service";
import { createCollaborationServer } from "../server";
import type { BoardRole, CollaborationContext, StoredDocument } from "../types";
import { BOARD_ID, ORIGIN, createTestClient, insertRectangle, waitFor } from "./helpers";
import type { TestClient } from "./helpers";

const servers: Server<CollaborationContext>[] = [];
const runtimes: BoardRuntime[] = [];
const peers: TestClient[] = [];

async function fixture() {
  const roles = new Map<string, BoardRole>([["student", "editor"], ["teacher", "owner"]]);
  const documents = new Map<string, StoredDocument>();
  const server = createCollaborationServer({ origins: [ORIGIN], port: 0,
    limits: { aclRefreshMs: 35, aclCheckTimeoutMs: 100, persistenceDebounceMs: 15, persistenceMaxDebounceMs: 35 } }, {
    repository: {
      async load(id) { return documents.get(id) ?? null; },
      async save(id, state) {
        const stored = { state: new Uint8Array(state), revision: (documents.get(id)?.revision ?? 0) + 1, savedAt: new Date() };
        documents.set(id, stored); return stored;
      },
      async health() { return true; },
    },
    async authenticate(headers, boardId) {
      const userId = headers.get("cookie")?.split("=")[1] ?? "";
      const role = roles.get(userId);
      return role ? { boardId, userId, sessionId: userId, name: userId, role } : null;
    },
    async revalidate(principal) { return roles.get(principal.userId) ?? null; },
  });
  await server.listen(); servers.push(server);
  const url = `ws://127.0.0.1:${server.address.port}`;
  return { server, roles, documents, url,
    runtime(httpRole: BoardRole) {
      vi.stubGlobal("WebSocket", class extends WebSocket {
        constructor(address: string) { super(address, { headers: { Origin: ORIGIN, Cookie: "rimo-test=student" } }); }
      });
      const session: BoardSession = { role: httpRole, user: { id: "student", name: "Ученик" },
        connection: { url, token: "cookie" },
        board: { id: BOARD_ID, role: httpRole, ownerId: "teacher", authorName: "Teacher", title: "Доска",
          imageUrl: "", createdAt: 0, updatedAt: 0, isFavorite: false } };
      const runtime = new BoardRuntime(session); runtimes.push(runtime); return runtime;
    },
    async peer() {
      const peer = createTestClient(url, "teacher"); peers.push(peer); await peer.connect(); return peer;
    },
  };
}

afterEach(async () => {
  runtimes.splice(0).forEach((runtime) => runtime.destroy());
  peers.splice(0).forEach((peer) => peer.destroy());
  await Promise.all(servers.splice(0).map((server) => server.destroy()));
  vi.unstubAllGlobals();
});

describe("authoritative role changes over real WebSockets", () => {
  it("uses the initial connected snapshot over a stale editor HTTP session", async () => {
    const context = await fixture();
    context.roles.set("student", "viewer");
    const runtime = context.runtime("editor");
    expect(runtime.board.canEdit).toBe(false);
    expect(runtime.getRole()).toBeNull();
    await waitFor(() => runtime.getState().synced && runtime.getRole() === "viewer");
    expect(runtime.session.role).toBe("editor");
    expect(runtime.board.canEdit).toBe(false);
    const teacher = await context.peer();
    insertRectangle(teacher.document, "visible-to-viewer", 40);
    await waitFor(() => runtime.board.getLayer("visible-to-viewer")?.x === 40);
    // The SDK was originally authenticated read-only; promotion must still send real updates.
    context.roles.set("student", "editor");
    await waitFor(() => runtime.getRole() === "editor" && runtime.board.canEdit);
    const [id] = runtime.board.insert([createLayer(LayerType.Rectangle, { x: 90, y: 0 }, { r: 0, g: 0, b: 0 })]);
    await waitFor(() => teacher.document.getMap<Y.Map<unknown>>("layers").get(id)?.get("x") === 90 && runtime.getState().saved);
  });

  it("demotes and promotes the same connection, continues peer sync and persists newly allowed edits", async () => {
    const context = await fixture();
    const runtime = context.runtime("viewer");
    await waitFor(() => runtime.board.canEdit);
    expect(runtime.getRole()).toBe("editor");
    const teacher = await context.peer();
    context.roles.set("student", "viewer");
    await waitFor(() => runtime.getRole() === "viewer");
    expect(runtime.board.canEdit).toBe(false);
    expect(runtime.getState().connected).toBe(true);
    expect(runtime.board.insert([createLayer(LayerType.Rectangle, { x: 0, y: 0 }, { r: 0, g: 0, b: 0 })])).toEqual([]);
    insertRectangle(teacher.document, "peer-while-viewer", 70);
    await waitFor(() => runtime.board.getLayer("peer-while-viewer")?.x === 70);
    context.roles.set("student", "editor");
    await waitFor(() => runtime.getRole() === "editor" && runtime.board.canEdit);
    const [id] = runtime.board.insert([createLayer(LayerType.Rectangle, { x: 120, y: 0 }, { r: 0, g: 0, b: 0 })]);
    await waitFor(() => teacher.document.getMap<Y.Map<unknown>>("layers").get(id)?.get("x") === 120 && runtime.getState().saved);
    const stored = new Y.Doc();
    Y.applyUpdate(stored, context.documents.get(BOARD_ID)!.state);
    expect(stored.getMap<Y.Map<unknown>>("layers").get(id)?.get("x")).toBe(120);
    stored.destroy();
    expect(context.server.hocuspocus.getConnectionsCount()).toBe(2);
  });

  it("never accepts role authority from a client stateless broadcast", async () => {
    const context = await fixture();
    context.roles.set("student", "viewer");
    const runtime = context.runtime("editor");
    await waitFor(() => runtime.getRole() === "viewer");
    runtime.provider.sendStateless(JSON.stringify({ type: "access-role", role: "owner" }));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(runtime.getRole()).toBe("viewer");
    const attacker = await context.peer();
    const message = new OutgoingMessage(BOARD_ID).writeBroadcastStateless(JSON.stringify({ type: "access-role", role: "owner" }));
    attacker.websocketProvider.webSocket!.send(message.toUint8Array());
    await waitFor(() => context.server.hocuspocus.getConnectionsCount() === 1);
    expect(runtime.getRole()).toBe("viewer");
    expect(runtime.board.canEdit).toBe(false);
    // Cached persistence ACK remains a persistence message, with the role unchanged.
    runtime.provider.sendStateless(JSON.stringify({ type: "persistence-status" }));
    await waitFor(() => runtime.getState().saved);
    expect(runtime.getRole()).toBe("viewer");
    expect(Buffer.from(context.documents.get(BOARD_ID)!.state).length).toBeGreaterThan(0);
  });

  it("does not revive revoked or expired access after the account becomes an editor again", async () => {
    const context = await fixture();
    const runtime = context.runtime("editor");
    await waitFor(() => runtime.board.canEdit);
    context.roles.delete("student");
    await waitFor(() => !!runtime.getState().error);
    context.roles.set("student", "editor");
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(runtime.getRole()).toBeNull();
    expect(runtime.board.canEdit).toBe(false);
    expect(runtime.getState().error).toContain("Доступ");
  });
});
