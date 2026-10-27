import type { Socket } from "node:net";

import { IncomingMessage, MessageType, Server } from "@hocuspocus/server";
import type { Connection } from "@hocuspocus/server";
import * as Y from "yjs";

import type { AccessRoleMessage } from "../lib/collaboration/protocol";
import { AccessGuard } from "./access-guard";
import { AwarenessGuard } from "./awareness";
import { withDeadline } from "./deadline";
import { DocumentPersistence } from "./persistence";
import { ReceiveGuard } from "./receive-guard";
import { RuntimeMetrics } from "./runtime-metrics";
import { CollaborationRejection, DEFAULT_LIMITS } from "./types";
import type { CollaborationContext, CollaborationDependencies, CollaborationLimits } from "./types";
import { UpdateGate } from "./update-gate";
import { ValidationCache } from "./validation-cache";

export interface CollaborationServerOptions {
  readonly origins: readonly string[];
  readonly address?: string;
  readonly port?: number;
  readonly limits?: Partial<CollaborationLimits>;
}

// PostgreSQL uuid folds case; Hocuspocus room names do not.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const WEBSOCKET_OPEN = 1;

export function createCollaborationServer(
  options: CollaborationServerOptions,
  dependencies: CollaborationDependencies,
): Server<CollaborationContext> {
  const limits = Object.freeze({ ...DEFAULT_LIMITS, ...options.limits });
  if (limits.aclRefreshMs <= 0 || limits.aclRefreshMs > 5_000) {
    throw new Error("ACL refresh must be between 1 and 5000 ms");
  }
  if (limits.aclCheckTimeoutMs <= 0 || limits.aclCheckTimeoutMs > 4_000) {
    throw new Error("ACL check timeout must be between 1 and 4000 ms");
  }
  const origins = new Set(options.origins);
  if (!origins.size || origins.has("*")) throw new Error("Exact allowed origins are required");
  const sockets = new Set<Socket>();
  const rooms = new Map<string, Y.Doc | symbol>();
  let stopping = false;
  const access = new AccessGuard(dependencies, limits);
  const awareness = new AwarenessGuard();
  const updates = new UpdateGate();
  const validation = new ValidationCache(limits);
  const receive = new ReceiveGuard(limits, (id) => access.release(id));
  const runtime = new RuntimeMetrics();
  const persistence = new DocumentPersistence(dependencies.repository, limits, (document) => {
    void server.hocuspocus.unloadDocument(document);
  });

  function assertActiveConnection(connection: Connection<CollaborationContext>): void {
    if (stopping || connection.document.isDestroyed || !connection.document.hasConnection(connection) ||
        connection.webSocket.readyState !== WEBSOCKET_OPEN) {
      throw new CollaborationRejection("Connection no longer active");
    }
  }

  const server = new Server<CollaborationContext>({
    name: "rimo-collaboration",
    address: options.address ?? "127.0.0.1",
    port: options.port ?? 1234,
    quiet: true,
    stopOnSignals: false,
    timeout: 60_000,
    debounce: limits.persistenceDebounceMs,
    maxDebounce: limits.persistenceMaxDebounceMs,
    unloadImmediately: false,
    maxUnauthenticatedQueueSize: limits.maxPayloadBytes,
    maxUnauthenticatedQueueMessages: 20,
    maxPendingDocuments: 1,
    websocketOptions: { maxPayload: limits.maxPayloadBytes, perMessageDeflate: false },

    async onUpgrade({ request, socket: untypedSocket }) {
      const socket = untypedSocket as Socket;
      const origin = request.headers.origin;
      if (stopping || !origin || !origins.has(origin) || sockets.size >= limits.maxConnections) {
        const status = origin && origins.has(origin) ? "503 Service Unavailable" : "403 Forbidden";
        socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
        // Hocuspocus treats a falsy rejection as an already-handled HTTP response.
        throw null;
      }
      sockets.add(socket);
      socket.once("close", () => sockets.delete(socket));
    },

    async onConnect({ documentName, requestHeaders }) {
      if (stopping) throw new CollaborationRejection("Server stopping");
      if (!UUID.test(documentName) || !origins.has(requestHeaders.get("origin") ?? "")) {
        throw new CollaborationRejection("Board or origin is not allowed");
      }
      if (!rooms.has(documentName) && rooms.size >= limits.maxOpenDocuments) {
        throw new CollaborationRejection("Server open board limit reached");
      }
    },

    async onAuthenticate({ token, documentName, requestHeaders, socketId, connectionConfig }) {
      if (token !== "cookie") throw new CollaborationRejection("Authentication required");
      const principal = await withDeadline(dependencies.authenticate(requestHeaders, documentName), limits.aclCheckTimeoutMs);
      if (stopping) throw new CollaborationRejection("Server stopping");
      if (!principal) throw new CollaborationRejection("Board access denied");
      connectionConfig.readOnly = principal.role === "viewer";
      return access.reserve(principal, socketId);
    },

    async connected({ connection, documentName }) {
      // SDK close removes registration before onDisconnect waits for pending messages.
      // Its receiver checks readOnly again immediately before applying an update.
      connection.onClose(() => {
        connection.readOnly = true;
        access.release(connection.context.reservationId);
      });
      try {
        access.activate(connection);
        receive.attach(connection);
      } catch {
        const id = connection.context.reservationId;
        access.release(id);
        receive.release(id);
        connection.readOnly = true;
        // The SDK has registered this Connection before invoking connected.
        connection.close({ code: 1008, reason: "Connection activation failed" });
        connection.webSocket.close(1008, "Connection activation failed");
        return;
      }
      const role: AccessRoleMessage = { type: "access-role", role: connection.context.role };
      connection.sendStateless(JSON.stringify(role));
      const acknowledgement = persistence.getAcknowledgement(documentName);
      if (acknowledgement) connection.sendStateless(JSON.stringify(acknowledgement));
    },

    async beforeHandleMessage({ context, update }) {
      await access.checkAccess(context);
      const message = new IncomingMessage(update);
      message.readVarString();
      if (message.readVarUint() === MessageType.BroadcastStateless) {
        throw new CollaborationRejection("Client broadcast is not allowed");
      }
    },

    async beforeSync({ type, payload, document, connection }) {
      if (type !== 1 && type !== 2) return;
      assertActiveConnection(connection);
      if (connection.readOnly) {
        if (!Y.snapshotContainsUpdate(Y.snapshot(document), payload)) {
          throw new CollaborationRejection("This board is read-only");
        }
        return;
      }
      await updates.acquire(document.name, connection.context.reservationId);
      try {
        assertActiveConnection(connection);
        await access.checkAccess(connection.context);
        assertActiveConnection(connection);
        if (connection.readOnly || connection.context.role === "viewer") {
          throw new CollaborationRejection("This board is read-only");
        }
        validation.validate(document.name, document, payload);
      } catch (error) {
        updates.release(connection.context.reservationId);
        throw error;
      }
    },

    async afterHandleMessage({ context, update }) {
      updates.release(context.reservationId);
      receive.processed(context.reservationId, update);
    },

    async beforeHandleAwareness({ context, states, removedClients }) {
      if (context) awareness.filter(context, states, removedClients);
    },

    async onLoadDocument({ document }) {
      rooms.set(document.name, document);
      document.on("destroy", () => {
        if (rooms.get(document.name) === document) rooms.delete(document.name);
      });
      try {
        if (stopping) throw new CollaborationRejection("Server stopping");
        await persistence.load(document);
        if (stopping) throw new CollaborationRejection("Server stopping");
      } catch (error) {
        validation.forget(document.name, document);
        persistence.forget(document.name);
        throw error;
      }
    },

    onStoreDocument({ document }) {
      return persistence.persist(document);
    },

    async beforeUnloadDocument({ document }) {
      if (!persistence.isPersisted(document)) throw new Error("Board has uncommitted changes");
    },

    async afterUnloadDocument({ documentName }) {
      validation.forget(documentName);
      persistence.forget(documentName);
    },

    async onStateless({ payload, connection, documentName }) {
      if (payload.length > 128) return;
      try {
        const message: unknown = JSON.parse(payload);
        if (typeof message !== "object" || message === null || !("type" in message) || message.type !== "persistence-status") return;
      } catch { return; }
      const acknowledgement = persistence.getAcknowledgement(documentName);
      if (acknowledgement) connection.sendStateless(JSON.stringify(acknowledgement));
    },

    async onDisconnect({ context }) {
      if (!context.reservationId) return;
      access.release(context.reservationId);
      awareness.release(context);
      updates.release(context.reservationId);
      receive.release(context.reservationId);
    },

    async onRequest({ request, response }) {
      if (request.method !== "GET" || !["/health", "/healthz"].includes(request.url ?? "")) {
        response.writeHead(404).end();
        throw null;
      }
      const healthy = persistence.healthy && await dependencies.repository.health();
      response.writeHead(healthy ? 200 : 503, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      response.end(JSON.stringify({ status: healthy ? "ok" : "unavailable", runtime: runtime.read() }));
      throw null;
    },

    async onListen() {
      runtime.start();
      access.start();
    },

    async onDestroy() {
      stopping = true;
      runtime.stop();
      access.stop();
      receive.stop();
      persistence.stop();
      validation.clear();
      rooms.clear();
      sockets.forEach((socket) => socket.destroy());
    },
  });

  const createDocument = server.hocuspocus.createDocument.bind(server.hocuspocus);
  server.hocuspocus.createDocument = async (...parameters) => {
    const name = parameters[0];
    let room = rooms.get(name);
    try {
      // Reserve synchronously after auth: the SDK loading map is still empty.
      // Hocuspocus 4.7.1 does not forward the configuration onCreateDocument hook.
      if (stopping) throw new CollaborationRejection("Server stopping");
      if (!room) {
        if (rooms.size >= limits.maxOpenDocuments) throw new CollaborationRejection("Server open board limit reached");
        room = Symbol(name);
        rooms.set(name, room);
      }
      return await createDocument(...parameters);
    } catch (error) {
      // Failed/shared loads have no Connection, so SDK onDisconnect never runs.
      const reservationId = parameters[4]?.reservationId;
      if (reservationId) access.release(reservationId);
      if (typeof room === "symbol" && rooms.get(name) === room) rooms.delete(name);
      throw error;
    }
  };
  const destroy = server.destroy.bind(server);
  server.destroy = () => { stopping = true; return destroy(); };
  return server;
}
