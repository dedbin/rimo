import { OutgoingMessage } from "@hocuspocus/server";
import type { Connection, ConnectionConfiguration, WebSocketLike } from "@hocuspocus/server";

import { AUTH_CONTROL_BYTES, isIngressDocumentName, readIngressMessage, validateAuthControl } from "./receive-transport";
import type { IngressClient } from "./receive-transport";
import { CollaborationRejection } from "./types";
import type { CollaborationContext, CollaborationLimits } from "./types";

interface ReceiveBudget {
  readonly frames: Map<Uint8Array, number>;
  readonly key: string;
  readonly documentName: string;
  readonly transport?: ReceiveTransport;
  queuedBytes: number;
  controlBytes: number;
  setupPending: boolean;
  messages: number;
  bytes: number;
  updatedAt: number;
  closed: boolean;
  reservationId?: string;
  connection?: Connection<CollaborationContext>;
}

interface ReceiveTransport {
  readonly webSocket: WebSocketLike;
  readonly routes: Map<string, ReceiveBudget>;
  readonly budgets: Set<ReceiveBudget>;
  readonly pendingAuth: ReceiveBudget[];
  readonly closeSdk: IngressClient["handleClose"];
  closed: boolean;
}

type LimitKind = "queued-messages" | "queued-bytes" | "total-bytes" | "message-rate" | "byte-rate" | "admission";
const RECEIVE_REASON = "Connection receive limit reached";

export class ReceiveGuard {
  private readonly budgets = new Set<ReceiveBudget>();
  private readonly reservations = new Map<string, ReceiveBudget>();
  private readonly transports = new WeakMap<Request, ReceiveTransport>();
  private readonly connections = new WeakMap<Connection<CollaborationContext>, ReceiveBudget>();
  private readonly configurations = new WeakMap<ConnectionConfiguration, ReceiveBudget>();

  constructor(
    private readonly limits: CollaborationLimits,
    private readonly reject: (reservationId: string) => void,
  ) {}

  watch(client: IngressClient, webSocket: WebSocketLike, request: Request): void {
    const handleMessage = client.handleMessage.bind(client);
    const transport: ReceiveTransport = { webSocket, routes: new Map(), budgets: new Set(), pendingAuth: [],
      closeSdk: client.handleClose.bind(client), closed: false };
    this.transports.set(request, transport);
    client.handleMessage = (update): void => {
      if (transport.closed || webSocket.readyState !== 1) return;
      try {
        const input = readIngressMessage(update);
        // Reject inherited Record keys before SDK routing while preserving auth failures.
        if (!isIngressDocumentName(input.documentName)) {
          const reason = "Board or origin is not allowed";
          if (update.byteLength <= AUTH_CONTROL_BYTES) {
            webSocket.send(new OutgoingMessage(input.key).writePermissionDenied(reason).toUint8Array());
          }
          throw new CollaborationRejection(reason);
        }
        // Match the SDK's exact-session lookup followed by its legacy-name fallback.
        const exact = transport.routes.get(input.key);
        const legacy = transport.routes.get(input.documentName);
        let budget = exact?.connection && !exact.closed ? exact
          : legacy?.connection && !legacy.closed ? legacy : exact;
        if (!budget) {
          // Match maxPendingDocuments=1 before SDK can discard an Auth frame without hooks.
          if ([...transport.routes.values()].some((entry) => !entry.reservationId && !entry.connection)) {
            this.report("admission", undefined, update.byteLength);
            throw new CollaborationRejection("Pending connection limit reached");
          }
          budget = this.createBudget(input.key, input.documentName, transport, update.byteLength);
          transport.routes.set(input.key, budget);
          transport.budgets.add(budget);
        }
        if (input.initialAuth && !budget.setupPending && !budget.connection) {
          if (update.byteLength > AUTH_CONTROL_BYTES) {
            this.report("queued-bytes", budget, update.byteLength);
            throw new CollaborationRejection("Authentication frame limit reached");
          }
          try {
            validateAuthControl(input.message, update.byteLength);
          } catch (error) {
            if (error instanceof CollaborationRejection) {
              webSocket.send(new OutgoingMessage(input.key).writePermissionDenied(error.reason).toUint8Array());
            }
            throw error;
          }
          if (this.totalQueuedBytes() + update.byteLength > this.limits.maxTotalQueuedBytes) {
            this.report("total-bytes", budget, update.byteLength);
            throw new CollaborationRejection(RECEIVE_REASON);
          }
          budget.controlBytes = update.byteLength;
          budget.setupPending = true;
          transport.pendingAuth.push(budget);
        } else if (!this.charge(budget, update)) {
          throw new CollaborationRejection(RECEIVE_REASON);
        }
        // The SDK keeps this exact Uint8Array through pre-auth buffering and drain.
        handleMessage(update);
      } catch (error) {
        this.closeTransport(transport, error instanceof CollaborationRejection ? error.reason : "Invalid connection frame");
      }
    };
    client.handleClose = (event): void => {
      transport.closed = true;
      transport.closeSdk(event);
      // handleClose synchronously deletes the SDK's pre-auth queues.
      this.clearPreAuth(transport);
    };
  }

  connect(request: Request, documentName: string, configuration: ConnectionConfiguration): void {
    const transport = this.transports.get(request);
    const budget = transport?.pendingAuth.shift();
    if (budget) this.configurations.set(configuration, budget);
    if (!transport || transport.closed || transport.webSocket.readyState !== 1 || !budget || budget.closed ||
        budget.documentName !== documentName) {
      throw new CollaborationRejection("Connection receive reservation expired");
    }
  }

  authenticate(request: Request, context: CollaborationContext, configuration: ConnectionConfiguration): void {
    const transport = this.transports.get(request);
    const budget = this.configurations.get(configuration);
    if (!transport || transport.closed || transport.webSocket.readyState !== 1 || !budget || budget.transport !== transport || budget.closed ||
        budget.documentName !== context.boardId || budget.reservationId || this.reservations.has(context.reservationId)) {
      throw new CollaborationRejection("Connection receive reservation expired");
    }
    budget.reservationId = context.reservationId;
    this.reservations.set(context.reservationId, budget);
  }

  failed(request: Request, error: unknown, configuration: ConnectionConfiguration): void {
    const transport = this.transports.get(request);
    if (!transport) return;
    const pending = this.configurations.get(configuration);
    const reason = error instanceof CollaborationRejection ? error.reason : "permission-denied";
    try {
      if (pending) {
        pending.setupPending = false;
        pending.controlBytes = 0;
        // Preserve the SDK's authenticationFailed notification before clearing its state.
        if (!transport.closed && transport.webSocket.readyState === 1) {
          transport.webSocket.send(new OutgoingMessage(pending.key).writePermissionDenied(reason).toUint8Array());
        }
      }
    } finally {
      this.closeTransport(transport, reason);
    }
  }

  loadFinished(reservationId: string): void {
    const budget = this.reservations.get(reservationId);
    if (budget?.closed && !budget.connection) {
      budget.setupPending = false;
      budget.controlBytes = 0;
      this.forget(budget);
    }
  }

  attach(connection: Connection<CollaborationContext>): void {
    if (this.connections.has(connection)) return;
    const id = connection.context.reservationId;
    let budget = this.reservations.get(id);
    if (budget?.connection || (!budget && this.transports.has(connection.request))) {
      throw new CollaborationRejection("Connection receive reservation expired");
    }
    if (!budget) {
      budget = this.createBudget(id, connection.context.boardId);
      budget.reservationId = id;
      this.reservations.set(id, budget);
    }
    const attached = budget;
    attached.connection = connection;
    attached.controlBytes = 0;
    attached.setupPending = false;
    this.connections.set(connection, attached);
    // Retain bytes and the slot until onDisconnect follows SDK drain.
    connection.onClose(() => {
      attached.closed = true;
      if (attached.transport?.routes.get(attached.key) === attached) attached.transport.routes.delete(attached.key);
    });
    if (attached.transport) return;
    // Direct Connection consumers have no ClientConnection ingress adapter.
    const handleMessage = connection.handleMessage.bind(connection);
    connection.handleMessage = (update): void => {
      if (attached.closed) return;
      if (this.charge(attached, update)) { handleMessage(update); return; }
      attached.closed = true;
      this.reject(id);
      connection.close({ code: 1008, reason: RECEIVE_REASON });
      connection.webSocket.close(1008, RECEIVE_REASON);
    };
  }

  processed(reservationId: string, update: Uint8Array): void {
    const budget = this.reservations.get(reservationId);
    const size = budget?.frames.get(update);
    if (!budget || size === undefined) return;
    budget.frames.delete(update);
    budget.queuedBytes -= size;
  }

  release(reservationId: string): void {
    const budget = this.reservations.get(reservationId);
    if (budget) this.forget(budget);
  }

  stop(): void {
    for (const budget of this.budgets) this.forget(budget);
  }

  private createBudget(key: string, documentName: string, transport?: ReceiveTransport, incomingBytes = 0): ReceiveBudget {
    if (this.budgets.size >= this.limits.maxConnections) {
      this.report("admission", undefined, incomingBytes);
      throw new CollaborationRejection("Server receive connection limit reached");
    }
    const budget: ReceiveBudget = { key, documentName, transport, frames: new Map(), queuedBytes: 0,
      controlBytes: 0, setupPending: false, messages: this.limits.maxMessagesPerSecond,
      bytes: this.limits.maxPayloadBytes, updatedAt: Date.now(), closed: false };
    this.budgets.add(budget);
    return budget;
  }

  private charge(budget: ReceiveBudget, update: Uint8Array): boolean {
    if (budget.closed) return false;
    const now = Date.now();
    const seconds = Math.max(0, now - budget.updatedAt) / 1_000;
    budget.updatedAt = now;
    budget.messages = Math.min(this.limits.maxMessagesPerSecond, budget.messages + seconds * this.limits.maxMessagesPerSecond);
    budget.bytes = Math.min(this.limits.maxPayloadBytes, budget.bytes + seconds * this.limits.maxBytesPerSecond);
    const kind: LimitKind | undefined = budget.frames.has(update) ? "admission"
      : budget.frames.size >= this.limits.maxQueuedMessages ? "queued-messages"
      : budget.queuedBytes + update.byteLength > this.limits.maxQueuedBytes ? "queued-bytes"
      : this.totalQueuedBytes() + update.byteLength > this.limits.maxTotalQueuedBytes ? "total-bytes"
      : budget.messages < 1 ? "message-rate"
      : budget.bytes < update.byteLength ? "byte-rate" : undefined;
    if (kind) { this.report(kind, budget, update.byteLength); return false; }
    budget.messages -= 1;
    budget.bytes -= update.byteLength;
    budget.frames.set(update, update.byteLength);
    budget.queuedBytes += update.byteLength;
    return true;
  }

  private totalQueuedBytes(): number {
    let total = 0;
    for (const budget of this.budgets) total += budget.queuedBytes + budget.controlBytes;
    return total;
  }

  private report(kind: LimitKind, budget: ReceiveBudget | undefined, incomingBytes: number): void {
    console.warn(JSON.stringify({ event: "collaboration_receive_limit", kind, queuedFrames: budget?.frames.size ?? 0,
      queuedBytes: budget?.queuedBytes ?? 0, totalQueuedBytes: this.totalQueuedBytes(), incomingBytes }));
  }

  private closeTransport(transport: ReceiveTransport, reason: string): void {
    transport.closed = true;
    for (const budget of transport.budgets) {
      budget.closed = true;
      if (budget.reservationId) this.reject(budget.reservationId);
    }
    try {
      transport.closeSdk({ code: 1008, reason });
      this.clearPreAuth(transport);
    } finally {
      transport.webSocket.close(1008, reason);
    }
  }

  private clearPreAuth(transport: ReceiveTransport): void {
    for (const budget of transport.budgets) {
      budget.closed = true;
      if (budget.connection) continue;
      budget.frames.clear();
      budget.queuedBytes = 0;
      // A bounded Auth decoder can still be held by authenticate/load continuations.
      if (!budget.setupPending) this.forget(budget);
    }
  }

  private forget(budget: ReceiveBudget): void {
    budget.closed = true;
    budget.frames.clear();
    budget.queuedBytes = 0;
    budget.controlBytes = 0;
    this.budgets.delete(budget);
    if (budget.reservationId && this.reservations.get(budget.reservationId) === budget) this.reservations.delete(budget.reservationId);
    budget.transport?.budgets.delete(budget);
    if (budget.transport?.routes.get(budget.key) === budget) budget.transport.routes.delete(budget.key);
  }
}
