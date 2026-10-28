import type { Socket } from "node:net";

import { writeAuthentication } from "@hocuspocus/common";
import { MessageType, OutgoingMessage } from "@hocuspocus/server";
import type { Server } from "@hocuspocus/server";
import { writeVarString, writeVarUint } from "lib0/encoding";
import { vi } from "vitest";
import WebSocket from "ws";

import { configureOfflineSync } from "../../lib/collaboration/offline-sync";
import { ReceiveGuard } from "../receive-guard";
import { createCollaborationServer } from "../server";
import type { CollaborationContext, CollaborationDependencies, CollaborationLimits, StoredDocument } from "../types";
import { createTestClient, ORIGIN, waitFor } from "./helpers";
import type { TestClient } from "./helpers";

const servers: Server<CollaborationContext>[] = [];
const clients: TestClient[] = [];
const sockets: WebSocket[] = [];
const releases: (() => void)[] = [];

export function ingressBarrier() {
  let release: () => void = () => undefined;
  const waiting = new Promise<void>((resolve) => { release = resolve; });
  releases.push(release);
  return { waiting, release };
}

export function authenticationFrame(name: string, version?: string): Uint8Array {
  const message = new OutgoingMessage(name);
  writeVarUint(message.encoder, MessageType.Auth);
  writeAuthentication(message.encoder, "cookie");
  if (version !== undefined) writeVarString(message.encoder, version);
  return message.toUint8Array();
}

export async function ingressFixture(
  configure?: (dependencies: CollaborationDependencies) => void,
  limits: Partial<CollaborationLimits> = {},
) {
  const snapshots = new Map<string, StoredDocument>();
  const forwarded: Uint8Array[] = [];
  const watch = ReceiveGuard.prototype.watch;
  vi.spyOn(ReceiveGuard.prototype, "watch").mockImplementation(function (this: ReceiveGuard, client, socket, request) {
    const handleMessage = client.handleMessage.bind(client);
    client.handleMessage = (update): void => { forwarded.push(update); handleMessage(update); };
    watch.call(this, client, socket, request);
  });
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
    async authenticate(headers, boardId) {
      const userId = headers.get("cookie")?.split("=")[1] ?? "writer";
      return { boardId, userId, sessionId: userId, name: userId, role: userId === "viewer" ? "viewer" : "editor" };
    },
    async revalidate(principal) { return principal.role; },
  };
  configure?.(dependencies);
  const server = createCollaborationServer({ origins: [ORIGIN], port: 0,
    limits: { persistenceDebounceMs: 10, persistenceMaxDebounceMs: 25, ...limits } }, dependencies);
  servers.push(server);
  await server.listen();
  const url = `ws://127.0.0.1:${server.address.port}`;
  return {
    server, snapshots, forwarded,
    provider(boardId: string, user = "writer", offlineSync = true): TestClient {
      const client = createTestClient(url, user, boardId);
      if (offlineSync) configureOfflineSync(client.websocketProvider);
      clients.push(client);
      return client;
    },
    async raw(boardId: string, authenticate = true) {
      const socket = new WebSocket(url, { headers: { Origin: ORIGIN, Cookie: "rimo-test=writer" } });
      sockets.push(socket);
      let closeCode = 0;
      let closeReason = "";
      let nativeSocket: Socket | undefined;
      socket.on("upgrade", (response) => { nativeSocket = response.socket; });
      socket.on("error", () => undefined);
      socket.on("close", (code, reason) => { closeCode = code; closeReason = reason.toString(); });
      await waitFor(() => socket.readyState === WebSocket.OPEN);
      if (authenticate) socket.send(authenticationFrame(boardId));
      return { socket, nativeSocket: () => nativeSocket!, closeCode: () => closeCode, closeReason: () => closeReason };
    },
  };
}

export async function closeIngressSocket(socket: WebSocket): Promise<void> {
  if (socket.readyState === WebSocket.OPEN) socket.close();
  await waitFor(() => socket.readyState === WebSocket.CLOSED);
}

export async function cleanupIngress(): Promise<void> {
  releases.splice(0).forEach((release) => release());
  clients.splice(0).forEach((client) => client.destroy());
  sockets.splice(0).forEach((socket) => socket.terminate());
  await Promise.all(servers.splice(0).map((server) => server.destroy()));
  vi.restoreAllMocks();
}
