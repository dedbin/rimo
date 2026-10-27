// @vitest-environment node

import { randomUUID } from "node:crypto";

import { writeAuthentication } from "@hocuspocus/common";
import { MessageType, OutgoingMessage } from "@hocuspocus/server";
import type { Connection, Server } from "@hocuspocus/server";
import { writeVarUint } from "lib0/encoding";
import { afterEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";

import { AccessGuard } from "../access-guard";
import { ReceiveGuard } from "../receive-guard";
import { createCollaborationServer } from "../server";
import { DEFAULT_LIMITS } from "../types";
import type { CollaborationContext, CollaborationDependencies, CollaborationLimits, StoredDocument } from "../types";

import { createTestClient, ORIGIN, waitFor } from "./helpers";
import type { TestClient } from "./helpers";

const servers: Server<CollaborationContext>[] = [];
const clients: TestClient[] = [];
const unblock: (() => void)[] = [];

function barrier() {
  let release: () => void = () => undefined;
  const waiting = new Promise<void>((resolve) => { release = resolve; });
  unblock.push(release);
  return { waiting, release };
}

async function fixture(
  configure?: (dependencies: CollaborationDependencies) => void,
  limits: Partial<CollaborationLimits> = {},
) {
  const snapshots = new Map<string, StoredDocument>();
  const dependencies: CollaborationDependencies = {
    repository: {
      async load(id) { return snapshots.get(id) ?? null; },
      async save(id, state) {
        const saved = { state: new Uint8Array(state), revision: (snapshots.get(id)?.revision ?? 0) + 1, savedAt: new Date() };
        snapshots.set(id, saved);
        return saved;
      },
      async health() { return true; },
    },
    async authenticate(_headers, boardId) {
      return { boardId, userId: "editor", sessionId: "editor", name: "Editor", role: "editor" };
    },
    async revalidate() { return "editor"; },
  };
  configure?.(dependencies);
  const server = createCollaborationServer({ origins: [ORIGIN], port: 0,
    limits: { maxOpenDocuments: 1, maxEditors: 2, persistenceDebounceMs: 20, persistenceMaxDebounceMs: 50, ...limits },
  }, dependencies);
  servers.push(server);
  await server.listen();
  function start(boardId: string) {
    const client = createTestClient(`ws://127.0.0.1:${server.address.port}`, "editor", boardId);
    clients.push(client);
    let rejected = "";
    client.provider.on("authenticationFailed", ({ reason }: { reason: string }) => {
      rejected = reason;
      client.websocketProvider.disconnect();
    });
    void client.websocketProvider.connect().catch(() => undefined);
    return { client, rejection: () => rejected };
  }
  return { server, start };
}

afterEach(async () => {
  unblock.splice(0).forEach((release) => release());
  clients.splice(0).forEach((client) => client.destroy());
  await Promise.all(servers.splice(0).map((server) => server.destroy()));
  vi.restoreAllMocks();
});

describe("room admission over real WebSocket connections", () => {
  it("admits only one new room after concurrent authentication, releases the rejected editor and permits the existing room", async () => {
    const auth = barrier();
    const loading = barrier();
    let authenticating = 0;
    const loaded: string[] = [];
    const context = await fixture((dependencies) => {
      const authenticate = dependencies.authenticate;
      dependencies.authenticate = async (...args) => {
        authenticating += 1;
        if (authenticating <= 2) await auth.waiting;
        return authenticate(...args);
      };
      dependencies.repository.load = async (id) => { loaded.push(id); await loading.waiting; return null; };
    });
    const attempts = [context.start(randomUUID()), context.start(randomUUID())];
    await waitFor(() => authenticating === 2);
    expect(context.server.hocuspocus.loadingDocuments.size).toBe(0);
    expect(context.server.hocuspocus.documents.size).toBe(0);
    auth.release();
    await waitFor(() => attempts.some((attempt) => attempt.rejection() !== ""));
    expect(loaded).toHaveLength(1);
    expect(attempts.find((attempt) => attempt.rejection())!.rejection()).toContain("open board limit");
    const winner = attempts.find((attempt) => !attempt.rejection())!;
    const joined = context.start(loaded[0]);
    await waitFor(() => joined.client.provider.isAuthenticated || joined.rejection() !== "");
    expect(joined.rejection()).toBe("");
    expect(loaded).toHaveLength(1);
    loading.release();
    await waitFor(() => winner.client.provider.isSynced && joined.client.provider.isSynced && winner.client.isPersisted());
    expect(context.server.hocuspocus.documents.size).toBe(1);
    expect(context.server.hocuspocus.getConnectionsCount()).toBe(2);
    const document = context.server.hocuspocus.documents.get(loaded[0])!;
    winner.client.destroy(); joined.client.destroy();
    await waitFor(() => document.isDestroyed && context.server.hocuspocus.documents.size === 0);
    const next = context.start(randomUUID());
    await waitFor(() => next.client.provider.isSynced);
    expect(context.server.hocuspocus.documents.size).toBe(1);
  });

  it("releases the room and every waiting editor when a shared document load fails", async () => {
    const loading = barrier();
    const broken = randomUUID();
    let loadStarted = false;
    let authenticated = 0;
    const context = await fixture((dependencies) => {
      const authenticate = dependencies.authenticate;
      dependencies.authenticate = async (...args) => { authenticated += 1; return authenticate(...args); };
      dependencies.repository.load = async (id) => {
        if (id === broken) { loadStarted = true; await loading.waiting; throw new Error("Test load failure"); }
        return null;
      };
    });
    const first = context.start(broken);
    await waitFor(() => loadStarted);
    const second = context.start(broken);
    await waitFor(() => authenticated === 2 && second.client.provider.isAuthenticated);
    loading.release();
    await waitFor(() => !!first.rejection() && !!second.rejection());
    await waitFor(() => context.server.hocuspocus.loadingDocuments.size === 0);
    expect(context.server.hocuspocus.documents.size).toBe(0);
    const next = context.start(randomUUID());
    await waitFor(() => next.client.provider.isSynced || !!next.rejection());
    expect(next.rejection()).toBe("");
    const peer = context.start(next.client.provider.configuration.name);
    await waitFor(() => peer.client.provider.isSynced || !!peer.rejection());
    expect(peer.rejection()).toBe("");
    expect(context.server.hocuspocus.getConnectionsCount()).toBe(2);
  });

  it("releases a disconnected client's reservation and room after the in-flight load completes", async () => {
    const loading = barrier();
    const original = randomUUID();
    let loadStarted = false;
    const context = await fixture((dependencies) => {
      dependencies.repository.load = async (id) => {
        if (id === original) { loadStarted = true; await loading.waiting; }
        return null;
      };
    }, { maxEditors: 1 });
    const leaving = context.start(original);
    await waitFor(() => loadStarted);
    const raw = leaving.client.websocketProvider.webSocket!;
    leaving.client.destroy();
    await waitFor(() => raw.readyState === 3);
    loading.release();
    await waitFor(() => !context.server.hocuspocus.loadingDocuments.size && !context.server.hocuspocus.documents.size);
    const next = context.start(randomUUID());
    await waitFor(() => next.client.provider.isSynced || !!next.rejection());
    expect(next.rejection()).toBe("");
  });

  it("closes an open socket and unloads its registered connection when a slow load outlives the reservation TTL", async () => {
    const loading = barrier();
    const reserving = vi.spyOn(AccessGuard.prototype, "reserve");
    const receiveRelease = vi.spyOn(ReceiveGuard.prototype, "release");
    const boardId = randomUUID();
    let loadStarted = false;
    const context = await fixture((dependencies) => {
      dependencies.repository.load = async (id) => {
        if (id === boardId) { loadStarted = true; await loading.waiting; }
        return null;
      };
    }, { maxEditors: 1 });
    // Send auth only: provider retries or queued sync writes must not close the socket for us.
    const socket = new WebSocket(`ws://127.0.0.1:${context.server.address.port}`, {
      headers: { Origin: ORIGIN, Cookie: "rimo-test=editor" },
    });
    let closeCode = 0;
    socket.on("error", () => undefined);
    socket.on("close", (code) => { closeCode = code; });
    try {
      await waitFor(() => socket.readyState === WebSocket.OPEN);
      const auth = new OutgoingMessage(boardId);
      writeVarUint(auth.encoder, MessageType.Auth);
      writeAuthentication(auth.encoder, "cookie");
      socket.send(auth.toUint8Array());
      await waitFor(() => loadStarted);
      const guard = reserving.mock.contexts[0] as AccessGuard;
      const expired = reserving.mock.results[0].value as CollaborationContext;
      const realNow = performance.now.bind(performance);
      vi.spyOn(performance, "now").mockImplementation(() => realNow() + 11_000);
      // reserve() synchronously prunes old pending slots, without a timer race.
      const probe = guard.reserve({ ...expired, userId: "ttl-probe" }, "ttl-probe");
      guard.release(probe.reservationId);
      await expect(guard.checkAccess(expired)).rejects.toThrow("Access revoked");
      expect(socket.readyState).toBe(WebSocket.OPEN);
      loading.release();
      await waitFor(() => socket.readyState === WebSocket.CLOSED, 1_000);
      await waitFor(() => !context.server.hocuspocus.loadingDocuments.size && !context.server.hocuspocus.documents.size);
      expect(closeCode).toBe(1008);
      expect(context.server.hocuspocus.getConnectionsCount()).toBe(0);
      expect(receiveRelease).toHaveBeenCalledWith(expired.reservationId);
      const next = context.start(randomUUID());
      await waitFor(() => next.client.provider.isSynced || !!next.rejection());
      expect(next.rejection()).toBe("");
    } finally { socket.terminate(); }
  });

  it("releases a reservation returned after its socket disconnected during authentication", async () => {
    const auth = barrier();
    const reserving = vi.spyOn(AccessGuard.prototype, "reserve");
    let authenticating = 0;
    const checked: string[] = [];
    const context = await fixture((dependencies) => {
      dependencies.authenticate = async (_headers, boardId) => {
        const userId = `editor-${++authenticating}`;
        if (authenticating === 1) await auth.waiting;
        return { boardId, userId, sessionId: userId, name: userId, role: "editor" };
      };
      dependencies.revalidate = async (principal) => { checked.push(principal.userId); return "editor"; };
    }, { maxEditors: 1, aclRefreshMs: 50 });
    const leaving = context.start(randomUUID());
    await waitFor(() => authenticating === 1);
    const raw = leaving.client.websocketProvider.webSocket!;
    leaving.client.destroy();
    await waitFor(() => raw.readyState === 3);
    auth.release();
    await waitFor(() => reserving.mock.calls.length === 1);
    const guard = reserving.mock.contexts[0] as AccessGuard;
    const pendingContext = reserving.mock.results[0].value as CollaborationContext;
    await expect(guard.checkAccess(pendingContext)).rejects.toThrow("Access revoked");
    expect(context.server.hocuspocus.documents.size).toBe(0);
    const next = context.start(randomUUID());
    await waitFor(() => next.client.provider.isSynced || !!next.rejection());
    expect(next.rejection()).toBe("");
    await waitFor(() => checked.includes("editor-2"));
    expect(checked).not.toContain("editor-1");
    await expect(guard.checkAccess(pendingContext)).rejects.toThrow("Access revoked");
    expect(context.server.hocuspocus.documents.size).toBe(1);
  });

  it("destroys a loading room instead of registering it after shutdown", async () => {
    const loading = barrier();
    let loadStarted = false;
    const context = await fixture((dependencies) => {
      dependencies.repository.load = async () => { loadStarted = true; await loading.waiting; return null; };
    });
    const pending = context.start(randomUUID());
    await waitFor(() => loadStarted);
    await context.server.destroy();
    loading.release();
    await waitFor(() => context.server.hocuspocus.loadingDocuments.size === 0);
    expect(context.server.hocuspocus.documents.size).toBe(0);
    expect(pending.client.provider.isSynced).toBe(false);
    await context.server.destroy();
  });

  it("does not reserve a connection when authentication resolves after shutdown", async () => {
    const auth = barrier();
    const reserving = vi.spyOn(AccessGuard.prototype, "reserve");
    let started = false;
    let finished = false;
    const context = await fixture((dependencies) => {
      const authenticate = dependencies.authenticate;
      dependencies.authenticate = async (...args) => {
        started = true;
        await auth.waiting;
        finished = true;
        return authenticate(...args);
      };
    });
    context.start(randomUUID());
    await waitFor(() => started);
    await context.server.destroy();
    auth.release();
    await waitFor(() => finished);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(reserving).not.toHaveBeenCalled();
    expect(context.server.hocuspocus.loadingDocuments.size).toBe(0);
    expect(context.server.hocuspocus.documents.size).toBe(0);
  });
});

it("expires pending reservations even while the periodic ACL check refreshes active peers", async () => {
  let now = 0;
  vi.spyOn(performance, "now").mockImplementation(() => now);
  let activeChecks = 0;
  let pendingChecks = 0;
  const guard = new AccessGuard({
    repository: { async load() { return null; }, async save() { return { revision: 1, savedAt: new Date() }; }, async health() { return true; } },
    async authenticate() { return null; },
    async revalidate(principal) {
      if (principal.userId === "active") activeChecks += 1;
      else pendingChecks += 1;
      return "editor";
    },
  }, { ...DEFAULT_LIMITS, maxEditors: 2, aclRefreshMs: 20 });
  function reserve(userId: string) {
    return guard.reserve({ boardId: randomUUID(), userId, sessionId: userId, name: userId, role: "editor" }, userId);
  }
  try {
    reserve("pending-disconnected");
    const context = reserve("active");
    guard.activate({ context } as Connection<CollaborationContext>);
    now = 9_000;
    guard.start();
    await waitFor(() => activeChecks >= 1);
    now = 11_000;
    expect(() => reserve("replacement")).not.toThrow();
    expect(pendingChecks).toBe(0);
  } finally { guard.stop(); }
});
