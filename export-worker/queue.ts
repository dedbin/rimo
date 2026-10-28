import { PDF_JOB_TIMEOUT_MS, PdfJobError } from "./contract";

interface Pending<T> {
  readonly operation: (signal: AbortSignal) => Promise<T>;
  readonly controller: AbortController;
  readonly resolve: (value: T) => void;
  readonly reject: (error: unknown) => void;
  readonly dispose: () => void;
  started: boolean;
}

export class PdfQueue {
  private running = false;
  private readonly pending: Pending<unknown>[] = [];

  constructor(private readonly maxWaiting = 2, private readonly timeoutMs = PDF_JOB_TIMEOUT_MS) {}

  get status(): { running: boolean; waiting: number } { return { running: this.running, waiting: this.pending.length }; }

  run<T>(operation: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (signal?.aborted) return Promise.reject(signal.reason);
    if (this.running && this.pending.length >= this.maxWaiting) {
      return Promise.reject(new PdfJobError(429, "PDF_BUSY", "Очередь PDF заполнена. Повторите немного позже."));
    }
    return new Promise<T>((resolve, reject) => {
      const controller = new AbortController();
      const abort = (): void => controller.abort(signal?.reason ?? new PdfJobError(499, "PDF_CANCELLED", "Экспорт отменён."));
      const timer = setTimeout(() => controller.abort(new PdfJobError(504, "PDF_TIMEOUT", "PDF не успел сформироваться. Уменьшите число страниц или размер области.")), this.timeoutMs);
      const item: Pending<T> = { operation, controller, resolve, reject, started: false, dispose: () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
      } };
      controller.signal.addEventListener("abort", () => {
        if (item.started) { reject(controller.signal.reason); return; }
        const index = this.pending.indexOf(item as Pending<unknown>);
        if (index !== -1) this.pending.splice(index, 1);
        item.dispose();
        reject(controller.signal.reason);
      }, { once: true });
      signal?.addEventListener("abort", abort, { once: true });
      this.pending.push(item as Pending<unknown>);
      this.next();
    });
  }

  private next(): void {
    if (this.running) return;
    const item = this.pending.shift();
    if (!item) return;
    if (item.controller.signal.aborted) { item.dispose(); this.next(); return; }
    this.running = true;
    item.started = true;
    void item.operation(item.controller.signal).then(item.resolve, item.reject).finally(() => {
      item.dispose();
      this.running = false;
      this.next();
    });
  }
}
