// @vitest-environment node
import { randomUUID } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import * as Y from "yjs";

import { initializeDocument } from "../collaboration-server/document";
import { insertRectangle, ORIGIN, waitFor } from "../collaboration-server/__tests__/helpers";
import { cleanupIngress, ingressBarrier, ingressFixture } from "../collaboration-server/__tests__/ingress-fixture";
import { BoardRuntime } from "../lib/collaboration/runtime";
import { parseParticipant } from "../lib/collaboration/presence";
import type { BoardSession } from "../types/service";

const runtimes: BoardRuntime[] = [];
const sockets: WebSocket[] = [];

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  vi.stubGlobal("WebSocket", class extends WebSocket {
    constructor(address: string) {
      super(address, { headers: { Origin: ORIGIN, Cookie: "rimo-test=viewer" } });
      this.on("error", () => undefined);
      sockets.push(this);
    }
  });
});

afterEach(async () => {
  runtimes.splice(0).forEach((runtime) => runtime.destroy());
  sockets.splice(0).forEach((socket) => socket.terminate());
  await cleanupIngress();
  vi.unstubAllGlobals();
});

function session(boardId: string, port: number): BoardSession {
  return { role: "viewer", user: { id: "viewer", name: "viewer" },
    connection: { url: `ws://127.0.0.1:${port}`, token: "cookie" },
    board: { id: boardId, role: "viewer", ownerId: "owner", title: "Доска", authorName: "owner",
      imageUrl: "", createdAt: 0, updatedAt: 0, isFavorite: false } };
}

describe("viewer presence during a real SDK reconnect", () => {
  it("keeps a moving local cursor out of the pending-load queue and publishes its latest state after sync", async () => {
    const loading = ingressBarrier();
    let block = false;
    let loadStarted = false;
    const context = await ingressFixture((dependencies) => {
      const load = dependencies.repository.load;
      dependencies.repository.load = async (id) => {
        if (block) { loadStarted = true; await loading.waiting; }
        return load(id);
      };
    });
    const boardId = randomUUID();
    const document = new Y.Doc();
    initializeDocument(document);
    insertRectangle(document, "selected");
    context.snapshots.set(boardId, { state: Y.encodeStateAsUpdate(document), revision: 1, savedAt: new Date() });
    document.destroy();
    const runtime = new BoardRuntime(session(boardId, context.server.address.port));
    runtimes.push(runtime);
    const transport = runtime.provider.configuration.websocketProvider;
    await waitFor(() => runtime.getState().synced && runtime.getRole() === "viewer");
    const previousSocket = transport.webSocket!;
    runtime.provider.disconnect();
    await waitFor(() => previousSocket.readyState === 3 && !context.server.hocuspocus.documents.has(boardId));
    block = true;
    const closed = vi.fn();
    runtime.provider.on("close", closed);
    const published = vi.spyOn(runtime.provider.awareness!, "setLocalStateField");
    let reconnectError: unknown;
    const connected = transport.connect().catch((error: unknown) => { reconnectError = error; });
    await waitFor(() => loadStarted && runtime.getState().connected && runtime.provider.isAuthenticated);
    expect(runtime.getState().synced).toBe(false);
    // Normal pointer cadence can continue through an existing viewer pointer capture.
    for (let x = 0; x < 30; x += 1) {
      runtime.updatePresence({ cursor: { x, y: -x }, selection: ["selected"] });
      await new Promise<void>((resolve) => setTimeout(resolve, 50));
    }
    expect(runtime.getSelf().presence.cursor).toEqual({ x: 29, y: -29 });
    expect(published).not.toHaveBeenCalled();
    expect(closed).not.toHaveBeenCalled();
    loading.release();
    await connected;
    expect(reconnectError).toBeUndefined();
    await waitFor(() => runtime.getState().synced && runtime.getRole() === "viewer");
    expect(published).toHaveBeenCalledTimes(1);
    expect(published).toHaveBeenCalledWith("presence", runtime.getSelf().presence);
    const peer = context.provider(boardId);
    await peer.connect();
    const participant = () => parseParticipant(runtime.board.doc.clientID,
      peer.provider.awareness!.getStates().get(runtime.board.doc.clientID) ?? {});
    await waitFor(() => participant()?.presence.cursor?.x === 29);
    expect(participant()?.presence).toMatchObject({ cursor: { x: 29, y: -29 }, selection: ["selected"] });
    expect(runtime.board.canEdit).toBe(false);
    expect(closed).not.toHaveBeenCalled();
    expect(console.warn).not.toHaveBeenCalled();
  }, 15_000);
});
