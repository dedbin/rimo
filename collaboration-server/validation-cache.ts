import { Buffer } from "node:buffer";

import * as Y from "yjs";

import { validateShadowUpdate } from "./document";
import { CollaborationRejection } from "./types";
import type { CollaborationLimits } from "./types";

interface ValidationEntry {
  readonly canonical: Y.Doc;
  readonly shadow: Y.Doc;
  readonly onDestroy: () => void;
  encoded: Buffer;
}

export interface ValidationCacheStats {
  readonly size: number;
  readonly created: number;
  readonly reused: number;
  readonly rejected: number;
}

function bufferView(state: Uint8Array): Buffer {
  return Buffer.from(state.buffer, state.byteOffset, state.byteLength);
}

/** Reuses validation allocations; the authoritative Y.Doc is never changed here. */
export class ValidationCache {
  private readonly entries = new Map<string, ValidationEntry>();
  private created = 0;
  private reused = 0;
  private rejected = 0;

  constructor(private readonly limits: CollaborationLimits) {
    if (!Number.isSafeInteger(limits.maxOpenDocuments) || limits.maxOpenDocuments < 1) {
      throw new Error("Validation cache requires a positive room limit");
    }
  }

  get statistics(): ValidationCacheStats {
    return { size: this.entries.size, created: this.created, reused: this.reused, rejected: this.rejected };
  }

  validate(roomName: string, canonical: Y.Doc, update: Uint8Array): void {
    if (canonical.isDestroyed) {
      this.forget(roomName, canonical);
      throw new CollaborationRejection("Board document was closed");
    }
    try {
      const current = Y.encodeStateAsUpdate(canonical);
      let entry = this.entries.get(roomName);
      // Snapshots omit pending structs/delete sets. Compare the complete binary state.
      if (!entry || entry.canonical !== canonical || !entry.encoded.equals(current)) {
        this.forget(roomName);
        entry = this.create(roomName, canonical, current);
      } else this.reused += 1;
      entry.encoded = bufferView(validateShadowUpdate(canonical, entry.shadow, update, this.limits));
    } catch (error) {
      this.rejected += 1;
      this.forget(roomName, canonical);
      if (error instanceof CollaborationRejection) throw error;
      throw new CollaborationRejection("Invalid board update");
    }
  }

  forget(roomName: string, expectedCanonical?: Y.Doc): void {
    const entry = this.entries.get(roomName);
    if (!entry || (expectedCanonical && entry.canonical !== expectedCanonical)) return;
    this.entries.delete(roomName);
    entry.canonical.off("destroy", entry.onDestroy);
    entry.shadow.destroy();
  }

  clear(): void {
    for (const name of this.entries.keys()) this.forget(name);
  }

  private create(roomName: string, canonical: Y.Doc, current: Uint8Array): ValidationEntry {
    if (this.entries.size >= this.limits.maxOpenDocuments) {
      this.forget(this.entries.keys().next().value!);
    }
    const shadow = new Y.Doc({ gc: canonical.gc, gcFilter: canonical.gcFilter });
    try { Y.applyUpdate(shadow, current); }
    catch (error) { shadow.destroy(); throw error; }
    const entry: ValidationEntry = { canonical, shadow, encoded: bufferView(current),
      onDestroy: () => this.forget(roomName, canonical) };
    this.entries.set(roomName, entry);
    canonical.on("destroy", entry.onDestroy);
    this.created += 1;
    return entry;
  }
}
