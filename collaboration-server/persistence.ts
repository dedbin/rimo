import { Buffer } from "node:buffer";

import type { Document } from "@hocuspocus/server";
import * as Y from "yjs";

import type { PersistedMessage, PersistenceErrorMessage } from "../lib/collaboration/protocol";
import { HttpError } from "../server/http-error";

import { initializeDocument, validateDocument } from "./document";
import { DocumentRemovedError } from "./types";
import type { CollaborationLimits, SnapshotRepository } from "./types";

export class DocumentPersistence {
  private readonly acknowledgements = new Map<string, PersistedMessage>();
  private readonly snapshots = new Map<string, Y.Snapshot>();
  private readonly queues = new Map<string, Promise<void>>();
  private readonly retries = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly failures = new Map<string, number>();
  private readonly removed = new Set<string>();
  private stopping = false;

  constructor(
    private readonly repository: SnapshotRepository,
    private readonly limits: CollaborationLimits,
    private readonly afterRetry: (document: Document) => void,
  ) {}

  get healthy(): boolean {
    return this.failures.size === 0;
  }

  getAcknowledgement(boardId: string): PersistedMessage | undefined {
    return this.acknowledgements.get(boardId);
  }

  isPersisted(document: Document): boolean {
    const saved = this.snapshots.get(document.name);
    return this.removed.has(document.name) || (!!saved && Y.equalSnapshots(Y.snapshot(document), saved));
  }

  async load(document: Document): Promise<void> {
    const stored = await this.repository.load(document.name);
    if (!stored) {
      initializeDocument(document);
      await this.persist(document);
      return;
    }
    if (stored.state.byteLength > this.limits.maxDocumentBytes) {
      throw new Error("Stored board exceeds the document limit");
    }
    Y.applyUpdate(document, stored.state);
    validateDocument(document, this.limits);
    const snapshot = Y.snapshot(document);
    this.snapshots.set(document.name, snapshot);
    this.acknowledgements.set(document.name, {
      type: "persisted",
      revision: stored.revision,
      snapshot: Buffer.from(Y.encodeSnapshot(snapshot)).toString("base64"),
      savedAt: stored.savedAt.toISOString(),
    });
  }

  persist(document: Document): Promise<void> {
    // Capture both synchronously. The document may change while COMMIT is pending.
    const state = validateDocument(document, this.limits);
    const snapshot = Y.snapshot(document);
    const encodedSnapshot = Buffer.from(Y.encodeSnapshot(snapshot)).toString("base64");
    const previous = this.queues.get(document.name) ?? Promise.resolve();
    const pending = previous.catch(() => undefined).then(async () => {
      try {
        const saved = await this.repository.save(document.name, state);
        const acknowledgement: PersistedMessage = {
          type: "persisted",
          revision: saved.revision,
          snapshot: encodedSnapshot,
          savedAt: saved.savedAt.toISOString(),
        };
        this.snapshots.set(document.name, snapshot);
        this.acknowledgements.set(document.name, acknowledgement);
        this.failures.delete(document.name);
        this.cancelRetry(document.name);
        document.broadcastStateless(JSON.stringify(acknowledgement));
      } catch (error) {
        if (error instanceof DocumentRemovedError) {
          this.removed.add(document.name);
          this.failures.delete(document.name);
          this.cancelRetry(document.name);
          document.getConnections().forEach((connection) => connection.close({ code: 1008, reason: "Board removed" }));
          setTimeout(() => this.afterRetry(document), 0);
          throw error;
        }
        const message: PersistenceErrorMessage = {
          type: "persistence-error",
          message: error instanceof HttpError && error.code === "GLOBAL_DOCUMENT_QUOTA_EXCEEDED"
            ? `${error.message} Изменения ещё не записаны. Освободите место или увеличьте лимит.`
            : "Изменения ещё не записаны. Сервер повторит попытку.",
        };
        document.broadcastStateless(JSON.stringify(message));
        this.scheduleRetry(document);
        // Do not let Hocuspocus unload an uncommitted document after disconnection.
        throw new Error("Board persistence failed");
      }
    });
    this.queues.set(document.name, pending);
    void pending.finally(() => {
      if (this.queues.get(document.name) === pending) this.queues.delete(document.name);
    }).catch(() => undefined);
    return pending;
  }

  forget(boardId: string): void {
    this.cancelRetry(boardId);
    this.acknowledgements.delete(boardId);
    this.snapshots.delete(boardId);
    this.failures.delete(boardId);
    this.removed.delete(boardId);
  }

  stop(): void {
    this.stopping = true;
    this.retries.forEach(clearTimeout);
    this.retries.clear();
  }

  private cancelRetry(boardId: string): void {
    const retry = this.retries.get(boardId);
    if (retry) clearTimeout(retry);
    this.retries.delete(boardId);
  }

  private scheduleRetry(document: Document): void {
    const failures = (this.failures.get(document.name) ?? 0) + 1;
    this.failures.set(document.name, failures);
    if (this.stopping || this.retries.has(document.name)) return;
    const delay = Math.min(30_000, 1_000 * 2 ** Math.min(failures, 5));
    const retry = setTimeout(() => {
      this.retries.delete(document.name);
      if (document.isDestroyed) return;
      void this.persist(document).then(() => this.afterRetry(document)).catch(() => undefined);
    }, delay);
    retry.unref();
    this.retries.set(document.name, retry);
  }
}
