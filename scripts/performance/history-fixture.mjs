import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { setImmediate as yieldTurn } from "node:timers/promises";

import { validateDocument } from "../../collaboration-server/document.ts";
import { DEFAULT_LIMITS } from "../../collaboration-server/types.ts";
import { Y } from "./common.mjs";
import { idAt } from "./fixture.mjs";

export const HISTORY_BATCH_SIZE = 500;
export const MAX_HISTORY_CYCLES = 512;
export const MAX_HISTORY_TARGET = DEFAULT_LIMITS.maxDocumentBytes - 64 * 1024;

function structureCounts(document) {
  let structs = 0, deletedStructs = 0;
  for (const entries of document.store.clients.values()) for (const entry of entries) {
    structs += 1; if (entry.deleted) deletedStructs += 1;
  }
  return { structs, deletedStructs, clients: document.store.clients.size };
}

/** Ages an unpublished scene using complete two-writer move/restore cycles. */
export async function prepareHistoryFixture(document, targetBytes, { signal } = {}) {
  signal?.throwIfAborted();
  assert.equal(document.gc, true, "History fixture requires normal Yjs garbage collection");
  const initial = validateDocument(document, DEFAULT_LIMITS);
  assert.ok(Number.isSafeInteger(targetBytes) && targetBytes >= initial.byteLength && targetBytes <= MAX_HISTORY_TARGET,
    "History target must cover the normal scene and leave at least 64 KiB below the document limit");
  const canonical = new Y.Doc({ gc: true }), writers = [new Y.Doc({ gc: true }), new Y.Doc({ gc: true })];
  try {
    Y.applyUpdate(canonical, initial);
    const writerIds = writers.map((writer) => writer.clientID);
    assert.equal(new Set(writerIds).size, 2);
    assert.ok(writerIds.every((id) => !canonical.store.clients.has(id)), "Temporary writers must have distinct client IDs");
    for (const writer of writers) Y.applyUpdate(writer, initial);
    const groups = writers.map((_writer, index) => Array.from({ length: HISTORY_BATCH_SIZE }, (_entry, offset) => {
      const id = idAt(index * HISTORY_BATCH_SIZE + offset), layer = canonical.getMap("layers").get(id);
      assert.ok(layer instanceof Y.Map, "History fixture requires two seeded groups of 500 objects");
      return { id, x: layer.get("x"), y: layer.get("y") };
    }));
    const move = (index, displaced) => {
      const writer = writers[index], before = Y.encodeStateVector(writer);
      writer.transact(() => { for (const point of groups[index]) {
        const layer = writer.getMap("layers").get(point.id);
        layer.set("x", point.x + (displaced ? 1 : 0)); layer.set("y", point.y + (displaced ? 1 : 0));
      } }, "synthetic-history-move500");
      const delta = Y.encodeStateAsUpdate(writer, before);
      Y.applyUpdate(canonical, delta); Y.applyUpdate(writers[1 - index], delta);
    };
    let accepted = initial, acceptedCycles = 0, attemptedCycles = 0, reachedBudget = targetBytes === initial.byteLength;
    const before = structureCounts(canonical);
    while (!reachedBudget && attemptedCycles < MAX_HISTORY_CYCLES) {
      signal?.throwIfAborted(); attemptedCycles += 1;
      // The final two moves restore originals; their encoded cost is included before accepting a cycle.
      move(0, true); move(1, true); move(0, false); move(1, false);
      const candidate = Y.encodeStateAsUpdate(canonical);
      if (candidate.byteLength > targetBytes) { reachedBudget = true; break; }
      accepted = candidate; acceptedCycles += 1; reachedBudget = candidate.byteLength === targetBytes;
      await yieldTurn();
    }
    assert.ok(reachedBudget, "History generation exhausted its explicit cycle bound");
    const generatorSha256 = createHash("sha256").update(await readFile(new URL(import.meta.url))).digest("hex");
    signal?.throwIfAborted();
    // Oversized trial cycles never reach the caller, and no binary bytes are edited.
    Y.applyUpdate(document, accepted);
    const final = validateDocument(document, DEFAULT_LIMITS);
    assert.ok(final.byteLength <= targetBytes);
    for (const group of groups) for (const point of group) {
      const layer = document.getMap("layers").get(point.id);
      assert.equal(layer.get("x"), point.x); assert.equal(layer.get("y"), point.y);
    }
    return { profile: "synthetic-two-writer-move500-history", version: 1, rawReplay: false, generatorSha256,
      targetBytes, initialBytes: initial.byteLength, finalBytes: final.byteLength, targetUndershootBytes: targetBytes - final.byteLength,
      before, after: structureCounts(document), gc: true, writerClientIds: writerIds, batchSize: HISTORY_BATCH_SIZE,
      acceptedCycles, acceptedTransactions: acceptedCycles * 4, attemptedCycles,
      generationBound: { cycles: MAX_HISTORY_CYCLES, transactions: MAX_HISTORY_CYCLES * 4, fieldWrites: MAX_HISTORY_CYCLES * 4 * HISTORY_BATCH_SIZE * 2 },
      coordinatesRestored: true, restoreBudget: "only a complete cycle including both restores may fit the target",
      strictValidation: true, validationLimits: "DEFAULT_LIMITS" };
  } finally { for (const writer of writers) writer.destroy(); canonical.destroy(); }
}
