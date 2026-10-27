import { setImmediate as yieldToEventLoop } from "node:timers/promises";

export class UpdateGate {
  private readonly pending = new Map<string, Promise<void>>();
  private readonly releases = new Map<string, () => void>();

  async acquire(boardId: string, reservationId: string): Promise<void> {
    const previous = this.pending.get(boardId) ?? Promise.resolve();
    let unlock: () => void = () => undefined;
    const current = new Promise<void>((resolve) => { unlock = resolve; });
    this.pending.set(boardId, current);
    await previous;
    // Yield even without a waiter: one SDK connection can drain its own queue in microtasks.
    await yieldToEventLoop();
    this.releases.set(reservationId, () => {
      unlock();
      if (this.pending.get(boardId) === current) this.pending.delete(boardId);
    });
  }

  release(reservationId: string): void {
    this.releases.get(reservationId)?.();
    this.releases.delete(reservationId);
  }
}
