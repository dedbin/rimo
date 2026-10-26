import type { Connection } from "@hocuspocus/server";

import type { CollaborationContext, CollaborationLimits } from "./types";

interface ReceiveBudget {
  frames: Map<Uint8Array, number>;
  queuedBytes: number;
  messages: number;
  bytes: number;
  updatedAt: number;
  closed: boolean;
}

export class ReceiveGuard {
  private readonly budgets = new Map<string, ReceiveBudget>();

  constructor(
    private readonly limits: CollaborationLimits,
    private readonly reject: (reservationId: string) => void,
  ) {}

  attach(connection: Connection<CollaborationContext>): void {
    const id = connection.context.reservationId;
    const budget: ReceiveBudget = {
      frames: new Map(), queuedBytes: 0, messages: this.limits.maxMessagesPerSecond,
      bytes: this.limits.maxPayloadBytes, updatedAt: Date.now(), closed: false,
    };
    this.budgets.set(id, budget);
    const handleMessage = connection.handleMessage.bind(connection);
    // The hook runs after dequeue. Bound arrival before Hocuspocus buffers the frame.
    connection.handleMessage = (update: Uint8Array): void => {
      if (budget.closed) return;
      const now = Date.now();
      const seconds = Math.max(0, now - budget.updatedAt) / 1_000;
      budget.updatedAt = now;
      budget.messages = Math.min(this.limits.maxMessagesPerSecond, budget.messages + seconds * this.limits.maxMessagesPerSecond);
      budget.bytes = Math.min(this.limits.maxPayloadBytes, budget.bytes + seconds * this.limits.maxBytesPerSecond);
      if (budget.frames.size >= this.limits.maxQueuedMessages ||
          budget.queuedBytes + update.byteLength > this.limits.maxQueuedBytes ||
          budget.messages < 1 || budget.bytes < update.byteLength) {
        budget.closed = true;
        this.reject(id);
        connection.close({ code: 1008, reason: "Connection receive limit reached" });
        connection.webSocket.close(1008, "Connection receive limit reached");
        return;
      }
      budget.messages -= 1;
      budget.bytes -= update.byteLength;
      budget.frames.set(update, update.byteLength);
      budget.queuedBytes += update.byteLength;
      handleMessage(update);
    };
  }

  processed(reservationId: string, update: Uint8Array): void {
    const budget = this.budgets.get(reservationId);
    const size = budget?.frames.get(update);
    if (!budget || size === undefined) return;
    budget.frames.delete(update);
    budget.queuedBytes -= size;
  }

  release(reservationId: string): void {
    const budget = this.budgets.get(reservationId);
    if (budget) {
      budget.closed = true;
      budget.frames.clear();
    }
    this.budgets.delete(reservationId);
  }

  stop(): void {
    for (const id of this.budgets.keys()) this.release(id);
  }
}
