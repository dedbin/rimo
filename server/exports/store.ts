import { randomBytes } from "node:crypto";

import { MAX_PDF_JOB_BYTES } from "../../export-worker/contract";
import type { PdfJob, PdfWarning } from "../../export-worker/contract";
import { HttpError } from "../http-error";

const SNAPSHOT_TTL_MS = 5 * 60_000;
interface StoredSnapshot {
  readonly boardId: string;
  readonly userId: string;
  readonly job: PdfJob;
  readonly warnings: readonly PdfWarning[];
  readonly bytes: number;
  readonly expiresAt: number;
  readonly timer: ReturnType<typeof setTimeout>;
}

export class PdfSnapshotStore {
  private readonly entries = new Map<string, StoredSnapshot>();
  private bytes = 0;
  private preparing = 0;
  private dispatching = 0;

  constructor(private readonly ttlMs = SNAPSHOT_TTL_MS, private readonly maxBytes = 64 * 1024 * 1024) {}

  async prepare<T>(operation: () => Promise<T>): Promise<T> {
    if (this.preparing >= 2) throw new HttpError(429, "PDF_PREVIEW_BUSY", "Предпросмотр уже готовится. Повторите немного позже.");
    this.preparing += 1;
    try { return await operation(); } finally { this.preparing -= 1; }
  }

  async dispatch<T>(operation: () => Promise<T>): Promise<T> {
    if (this.dispatching >= 3) throw new HttpError(429, "PDF_BUSY", "Очередь PDF заполнена. Повторите немного позже.");
    this.dispatching += 1;
    try { return await operation(); } finally { this.dispatching -= 1; }
  }

  put(boardId: string, userId: string, job: PdfJob, warnings: readonly PdfWarning[]): { token: string; expiresAt: number } {
    this.expire();
    const bytes = Buffer.byteLength(JSON.stringify(job), "utf8");
    if (bytes > MAX_PDF_JOB_BYTES) throw new HttpError(413, "PDF_SNAPSHOT_TOO_LARGE", "Снимок PDF слишком большой. Уменьшите область экспорта.");
    const own = [...this.entries].filter(([, entry]) => entry.userId === userId);
    if (own.length >= 2) this.remove(own[0][0]);
    if (this.entries.size >= 4 || this.bytes + bytes > this.maxBytes) throw new HttpError(429, "PDF_SNAPSHOTS_BUSY", "Предпросмотры занимают доступную память. Закройте ненужные и повторите.");
    const token = randomBytes(24).toString("base64url");
    const expiresAt = Date.now() + this.ttlMs;
    const timer = setTimeout(() => this.remove(token), this.ttlMs);
    timer.unref?.();
    this.entries.set(token, { boardId, userId, job, warnings, bytes, expiresAt, timer });
    this.bytes += bytes;
    return { token, expiresAt };
  }

  get(token: string, boardId: string, userId: string): StoredSnapshot {
    this.expire();
    const snapshot = this.entries.get(token);
    if (!snapshot || snapshot.boardId !== boardId || snapshot.userId !== userId) {
      throw new HttpError(404, "PDF_PREVIEW_EXPIRED", "Предпросмотр истёк или недоступен. Создайте его заново.");
    }
    return snapshot;
  }

  delete(token: string, boardId: string, userId: string): void {
    this.get(token, boardId, userId);
    this.remove(token);
  }

  private expire(): void {
    for (const [token, entry] of this.entries) if (entry.expiresAt <= Date.now()) this.remove(token);
  }
  private remove(token: string): void {
    const entry = this.entries.get(token);
    if (!entry) return;
    clearTimeout(entry.timer);
    this.bytes -= entry.bytes;
    this.entries.delete(token);
  }
}

const storeKey = Symbol.for("rimo.pdf.snapshot-store");
const scope = globalThis as typeof globalThis & { [storeKey]?: PdfSnapshotStore };
export function pdfSnapshotStore(): PdfSnapshotStore { return scope[storeKey] ??= new PdfSnapshotStore(); }
