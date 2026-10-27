// @vitest-environment node
import { setImmediate as nextTurn } from "node:timers/promises";

import type { Connection, Server } from "@hocuspocus/server";
import * as Y from "yjs";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createCollaborationServer } from "../server";
import type { BoardRole, CollaborationContext, CollaborationPrincipal, StoredDocument } from "../types";
import { UpdateGate } from "../update-gate";
import { BOARD_ID, ORIGIN, createTestClient, insertRectangle, waitFor } from "./helpers";
import type { TestClient } from "./helpers";

const servers: Server<CollaborationContext>[] = [];
const clients: TestClient[] = [];
const releases: (() => void)[] = [];

function deferred() {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

async function fixture() {
  const roles = new Map<string, BoardRole>([["writer", "editor"], ["observer", "owner"]]);
  const documents = new Map<string, StoredDocument>();
  const revalidate = vi.fn(async (principal: CollaborationPrincipal) => roles.get(principal.userId) ?? null);
  const server = createCollaborationServer({ origins: [ORIGIN], port: 0,
    limits: { aclRefreshMs: 35, aclCheckTimeoutMs: 100, persistenceDebounceMs: 10, persistenceMaxDebounceMs: 25 } }, {
    repository: {
      async load(id) { return documents.get(id) ?? null; },
      async save(id, state) {
        const stored = { state: new Uint8Array(state), revision: (documents.get(id)?.revision ?? 0) + 1, savedAt: new Date() };
        documents.set(id, stored);
        return stored;
      },
      async health() { return true; },
    },
    async authenticate(headers, boardId) {
      const userId = headers.get("cookie")?.split("=")[1] ?? "";
      const role = roles.get(userId);
      return role ? { boardId, userId, sessionId: userId, name: userId, role } : null;
    },
    revalidate,
  });
  await server.listen();
  servers.push(server);
  const url = `ws://127.0.0.1:${server.address.port}`;
  const writer = createTestClient(url, "writer");
  const observer = createTestClient(url, "observer");
  clients.push(writer, observer);
  await writer.connect();
  await observer.connect();
  insertRectangle(writer.document, "rectangle");
  await waitFor(() => writer.isPersisted() && observer.document.getMap("layers").has("rectangle"));
  const document = server.hocuspocus.documents.get(BOARD_ID)!;
  const connection = document.getConnections().find((entry) => entry.context.userId === "writer") as Connection<CollaborationContext>;
  await connection.waitForPendingMessages();
  return { server, roles, revalidate, writer, observer, document, connection,
    x() { return document.getMap<Y.Map<unknown>>("layers").get("rectangle")!.get("x"); },
  };
}

async function queueUpdate(context: Awaited<ReturnType<typeof fixture>>, x: number) {
  const entered = deferred();
  const resume = deferred();
  releases.push(resume.resolve);
  const acquire = UpdateGate.prototype.acquire;
  vi.spyOn(UpdateGate.prototype, "acquire").mockImplementation(async function (this: UpdateGate, boardId, reservationId) {
    await acquire.call(this, boardId, reservationId);
    if (reservationId === context.connection.context.reservationId) {
      entered.resolve();
      await resume.promise;
    }
  });
  context.writer.document.getMap<Y.Map<unknown>>("layers").get("rectangle")!.set("x", x);
  await entered.promise;
  return async () => {
    resume.resolve();
    await context.connection.waitForPendingMessages();
  };
}

afterEach(async () => {
  releases.splice(0).forEach((release) => release());
  clients.splice(0).forEach((client) => client.destroy());
  await Promise.all(servers.splice(0).map((server) => server.destroy()));
  vi.restoreAllMocks();
});

describe("queued updates across real SDK connection lifecycles", () => {
  it("does not apply a queued update after SDK close while its WebSocket is still open", async () => {
    const context = await fixture();
    const resume = await queueUpdate(context, 50);
    context.connection.close({ code: 1008, reason: "Test connection close" });
    expect(context.document.hasConnection(context.connection)).toBe(false);
    expect(context.connection.webSocket.readyState).toBe(1);
    await resume();
    expect(context.x()).toBe(0);
    expect(context.connection.readOnly).toBe(true);
    insertRectangle(context.observer.document, "next-writer");
    await waitFor(() => context.document.getMap("layers").has("next-writer") && context.observer.isPersisted());
  });

  it("does not apply a queued update once the WebSocket starts closing", async () => {
    const context = await fixture();
    const resume = await queueUpdate(context, 50);
    context.connection.webSocket.close(1008, "Test WebSocket close");
    expect(context.connection.webSocket.readyState).toBe(2);
    await resume();
    expect(context.x()).toBe(0);
  });

  it("does not restore write access when an earlier ACL check finishes after SDK close", async () => {
    const context = await fixture();
    const resume = await queueUpdate(context, 50);
    const checking = deferred();
    const decision = deferred();
    releases.push(decision.resolve);
    context.revalidate.mockImplementation(async (principal) => {
      if (principal.userId === "writer") {
        checking.resolve();
        await decision.promise;
      }
      return context.roles.get(principal.userId) ?? null;
    });
    await checking.promise;
    context.connection.close({ code: 1008, reason: "Test close during ACL check" });
    decision.resolve();
    await nextTurn();
    expect(context.connection.readOnly).toBe(true);
    await resume();
    expect(context.x()).toBe(0);
  });

  it("does not apply a queued update after access is revoked", async () => {
    const context = await fixture();
    const resume = await queueUpdate(context, 50);
    context.roles.delete("writer");
    await waitFor(() => !context.document.hasConnection(context.connection));
    await resume();
    expect(context.x()).toBe(0);
  });

  it("uses the current viewer role after waiting in the queue", async () => {
    const context = await fixture();
    const resume = await queueUpdate(context, 50);
    context.roles.set("writer", "viewer");
    await waitFor(() => context.connection.readOnly);
    await resume();
    expect(context.x()).toBe(0);
  });

  it("does not apply a queued update after shutdown starts", async () => {
    const context = await fixture();
    const resume = await queueUpdate(context, 50);
    const stopped = context.server.destroy();
    await resume();
    await stopped;
    expect(context.x()).toBe(0);
  });

  it("releases the gate after a validation rejection so another writer can update", async () => {
    const context = await fixture();
    const resume = await queueUpdate(context, Number.NaN);
    await resume();
    await waitFor(() => !context.document.hasConnection(context.connection));
    expect(context.x()).toBe(0);
    insertRectangle(context.observer.document, "valid-update");
    await waitFor(() => context.document.getMap("layers").has("valid-update") && context.observer.isPersisted());
  });
});
