export class UpdateGate {
  private readonly pending = new Map<string, Promise<void>>();
  private readonly releases = new Map<string, () => void>();

  async acquire(boardId: string, reservationId: string): Promise<void> {
    const previous = this.pending.get(boardId) ?? Promise.resolve();
    let unlock: () => void = () => undefined;
    const current = new Promise<void>((resolve) => { unlock = resolve; });
    this.pending.set(boardId, current);
    await previous;
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
