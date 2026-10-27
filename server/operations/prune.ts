import type { Pool } from "pg";

import { assertStorageRoot, isOldOwnedFile, MIN_ORPHAN_AGE_MS, openStorageRoot, OperationsError, OWNED_ASSET_NAME, removeUnchangedFile, safeNumber, storageEntries } from "./storage";
import type { OrphanCandidate, StorageRoot } from "./storage";

const MAX_CANDIDATES = 1000;
type CandidateAction = "would-remove" | "removed" | "kept-referenced" | "kept-changed" | "not-processed";
export interface PruneReport {
  readonly version: 1; readonly checkedAt: string; readonly mode: "dry-run" | "apply";
  readonly status: "completed" | "aborted"; readonly minimumAgeHours: 24;
  readonly scannedEntries: number; readonly limited: boolean; readonly removedCount: number;
  readonly skipped: { readonly referenced: number; readonly unsafeOrFresh: number; readonly directories: number; readonly links: number; readonly unknownNames: number };
  readonly candidates: readonly { readonly key: string; readonly bytes: number; readonly action: CandidateAction }[];
  readonly reasonCodes: readonly string[];
}

/** Protect the final reference check and unlink with a short lock for this file only. */
export async function removeOrphanCandidate(
  database: Pool, root: StorageRoot, candidate: OrphanCandidate, cutoff: number,
): Promise<"removed" | "kept-referenced" | "kept-changed"> {
  const client = await database.connect().catch(() => { throw new OperationsError("DATABASE_CHECK_FAILED"); });
  let removed = false;
  let stage: "database" | "storage" = "database";
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL lock_timeout = '3s'");
    await client.query("SET LOCAL statement_timeout = '5s'");
    await client.query("LOCK TABLE assets IN SHARE MODE");
    const reference = await client.query("SELECT 1 FROM assets WHERE lower(storage_key) = lower($1) LIMIT 1", [candidate.key]);
    let outcome: "removed" | "kept-referenced" | "kept-changed" = "kept-referenced";
    if (!reference.rows.length) {
      stage = "storage";
      removed = await removeUnchangedFile(root, candidate, cutoff);
      outcome = removed ? "removed" : "kept-changed";
    }
    stage = "database";
    await client.query("COMMIT");
    return outcome;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw new OperationsError(error instanceof OperationsError ? error.code : stage === "database" ? "DATABASE_CHECK_FAILED" : "STORAGE_FILE_CHECK_FAILED", removed);
  } finally { client.release(); }
}

export async function pruneOrphanAssets(options: {
  readonly database: Pool; readonly uploadDir: string; readonly apply?: boolean; readonly now?: number;
}): Promise<PruneReport> {
  const now = options.now ?? Date.now();
  const cutoff = now - MIN_ORPHAN_AGE_MS;
  const candidates: OrphanCandidate[] = [];
  const files: { key: string; bytes: number; action: CandidateAction }[] = [];
  const skipped = { referenced: 0, unsafeOrFresh: 0, directories: 0, links: 0, unknownNames: 0 };
  let scannedEntries = 0; let limited = false; let removedCount = 0;
  let stage: "database" | "storage" = "database";
  try {
    if (!Number.isSafeInteger(now) || cutoff < 0 || now > 8.64e15) throw new OperationsError("CLOCK_INVALID");
    // If PostgreSQL is unavailable, do not even begin the filesystem scan.
    await options.database.query("SELECT storage_key FROM assets LIMIT 0");
    stage = "storage";
    const root = await openStorageRoot(options.uploadDir);
    const batch: OrphanCandidate[] = [];
    const checkBatch = async (): Promise<void> => {
      if (!batch.length) return;
      stage = "database";
      const references = await options.database.query<{ storage_key: string }>(
        "SELECT storage_key FROM assets WHERE lower(storage_key) = ANY($1::text[])", [batch.map((file) => file.key.toLowerCase())],
      );
      stage = "storage";
      const referenced = new Set(references.rows.map((row) => row.storage_key.toLowerCase()));
      for (const candidate of batch) {
        if (referenced.has(candidate.key.toLowerCase())) { skipped.referenced += 1; continue; }
        if (candidates.length >= MAX_CANDIDATES) { limited = true; break; }
        candidates.push(candidate);
        files.push({ key: candidate.key, bytes: safeNumber(candidate.identity.size), action: options.apply ? "not-processed" : "would-remove" });
      }
      batch.length = 0;
    };
    for await (const { key, identity } of storageEntries(root)) {
      scannedEntries += 1;
      if (identity.isSymbolicLink()) { skipped.links += 1; continue; }
      if (identity.isDirectory()) { skipped.directories += 1; continue; }
      if (!OWNED_ASSET_NAME.test(key)) { skipped.unknownNames += 1; continue; }
      if (!isOldOwnedFile(key, identity, cutoff)) { skipped.unsafeOrFresh += 1; continue; }
      batch.push({ key, identity });
      if (batch.length >= 100) await checkBatch();
      if (limited) break;
    }
    await checkBatch();
    await assertStorageRoot(root);
    if (options.apply) {
      for (let index = 0; index < candidates.length; index += 1) {
        try {
          files[index].action = await removeOrphanCandidate(options.database, root, candidates[index], cutoff);
          if (files[index].action === "removed") removedCount += 1;
        } catch (error) {
          if (error instanceof OperationsError && error.removed) { files[index].action = "removed"; removedCount += 1; }
          throw error;
        }
      }
    }
    return { version: 1, checkedAt: new Date(now).toISOString(), mode: options.apply ? "apply" : "dry-run", status: "completed",
      minimumAgeHours: 24, scannedEntries, limited, removedCount, skipped, candidates: files, reasonCodes: [] };
  } catch (error) {
    return { version: 1, checkedAt: new Date(Number.isSafeInteger(now) && now >= 0 && now <= 8.64e15 ? now : Date.now()).toISOString(),
      mode: options.apply ? "apply" : "dry-run", status: "aborted", minimumAgeHours: 24, scannedEntries, limited, removedCount, skipped,
      candidates: files, reasonCodes: [error instanceof OperationsError ? error.code : stage === "database" ? "DATABASE_CHECK_FAILED" : "STORAGE_CHECK_FAILED"] };
  }
}
