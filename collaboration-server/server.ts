import type { Socket } from "node:net";

import { IncomingMessage, MessageType, Server } from "@hocuspocus/server";
import * as Y from "yjs";

import { AccessGuard } from "./access-guard";
import { AwarenessGuard } from "./awareness";
import { withDeadline } from "./deadline";
import { validateIncomingUpdate } from "./document";
import { DocumentPersistence } from "./persistence";
import { ReceiveGuard } from "./receive-guard";
import { CollaborationRejection, DEFAULT_LIMITS } from "./types";
import type { CollaborationContext, CollaborationDependencies, CollaborationLimits } from "./types";
import { UpdateGate } from "./update-gate";

export interface CollaborationServerOptions {
  readonly origins: readonly string[];
  readonly address?: string;
  readonly port?: number;
  readonly limits?: Partial<CollaborationLimits>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
  const access = new AccessGuard(dependencies, limits);
  const awareness = new AwarenessGuard();
  const updates = new UpdateGate();
  const receive = new ReceiveGuard(limits, (id) => access.release(id));
  const persistence = new DocumentPersistence(dependencies.repository, limits, (document) => {
    void server.hocuspocus.unloadDocument(document);
  });

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
      if (!origin || !origins.has(origin) || sockets.size >= limits.maxConnections) {
        const status = origin && origins.has(origin) ? "503 Service Unavailable" : "403 Forbidden";
        socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
        // Hocuspocus treats a falsy rejection as an already-handled HTTP response.
        throw null;
      }
      sockets.add(socket);
      socket.once("close", () => sockets.delete(socket));
    },

    async onConnect({ documentName, requestHeaders, instance }) {
      if (!UUID.test(documentName) || !origins.has(requestHeaders.get("origin") ?? "")) {
        throw new CollaborationRejection("Board or origin is not allowed");
      }
      if (!instance.documents.has(documentName) && !instance.loadingDocuments.has(documentName) &&
          instance.documents.size + instance.loadingDocuments.size >= limits.maxOpenDocuments) {
        throw new CollaborationRejection("Server open board limit reached");
      }
    },

    async onAuthenticate({ token, documentName, requestHeaders, socketId, connectionConfig }) {
      if (token !== "cookie") throw new CollaborationRejection("Authentication required");
      const principal = await withDeadline(dependencies.authenticate(requestHeaders, documentName), limits.aclCheckTimeoutMs);
      if (!principal) throw new CollaborationRejection("Board access denied");
      connectionConfig.readOnly = principal.role === "viewer";
      return access.reserve(principal, socketId);
    },

    async connected({ connection, documentName }) {
      access.activate(connection);
      receive.attach(connection);
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
      if (connection.readOnly) {
        if (!Y.snapshotContainsUpdate(Y.snapshot(document), payload)) {
          throw new CollaborationRejection("This board is read-only");
        }
        return;
      }
      await updates.acquire(document.name, connection.context.reservationId);
      try {
        if (connection.readOnly) throw new CollaborationRejection("This board is read-only");
        validateIncomingUpdate(document, payload, limits);
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
      try {
        await persistence.load(document);
      } catch (error) {
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
      response.end(JSON.stringify({ status: healthy ? "ok" : "unavailable" }));
      throw null;
    },

    async onListen() {
      access.start();
    },

    async onDestroy() {
      access.stop();
      receive.stop();
      persistence.stop();
    },
  });

  return server;
}
