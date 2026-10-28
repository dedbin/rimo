import assert from "node:assert/strict";

import { validateDocument } from "../../../collaboration-server/document.ts";
import { DEFAULT_LIMITS } from "../../../collaboration-server/types.ts";
import { LayerType } from "../../../types/board-canvas.ts";

import { Y } from "../common.mjs";
import { idAt, seedScene, VISIBLE_OBJECTS } from "../fixture.mjs";

export const UPPER_DOCUMENT_LIMIT = 5 * 1024 * 1024;
export const UPPER_DOCUMENT_RESERVE = 64 * 1024;
export const UPPER_DOCUMENT_TARGET = UPPER_DOCUMENT_LIMIT - UPPER_DOCUMENT_RESERVE;
export const UPPER_DOCUMENT_TOLERANCE = 64;
const MAX_POINTS = 50_000;
const PATH_COUNT = 4;

export function upperDocumentBudget(bytes) {
  assert.ok(Number.isSafeInteger(bytes) && bytes >= UPPER_DOCUMENT_TARGET - UPPER_DOCUMENT_TOLERANCE &&
    bytes <= UPPER_DOCUMENT_TARGET, "Upper fixture must fit within 64 bytes below its target");
  return { actualDocumentBytes: bytes, targetDocumentBytes: UPPER_DOCUMENT_TARGET,
    documentLimitBytes: UPPER_DOCUMENT_LIMIT, reservedSlackBytes: UPPER_DOCUMENT_RESERVE,
    actualSlackBytes: UPPER_DOCUMENT_LIMIT - bytes, targetUndershootBytes: UPPER_DOCUMENT_TARGET - bytes };
}

function unusedClientId(document, reserved) {
  let identifier = 0x5a17c1;
  while (document.store.clients.has(identifier) || identifier === reserved) identifier += 1;
  return identifier;
}

export function validateUpperDocument(document) {
  return validateDocument(document, DEFAULT_LIMITS).byteLength;
}

function pathPoints(slot) {
  // Each nonzero low-bit fraction survives float64 but cannot fit in float32.
  // Points remain inside the original 26x22 offscreen layer bounds.
  return Array.from({ length: MAX_POINTS }, (_entry, index) => [
    index % 26 + 0.25 + (index % 997 + slot + 1) / 2 ** 40,
    index * 7 % 22 + 0.125 + (index % 991 + slot + 1) / 2 ** 40,
    0.5 + (index % 983 + slot + 1) / 2 ** 40,
  ]);
}

/** Builds offline and returns one update. The caller's document is never changed. */
export function prepareUpperFixture(document, assetUrl) {
  assert.equal(DEFAULT_LIMITS.maxDocumentBytes, UPPER_DOCUMENT_LIMIT, "Upper fixture expects the standard 5 MiB limit");
  const original = Y.encodeStateAsUpdate(document);
  const vector = Y.encodeStateVector(document);
  const base = new Y.Doc({ gc: document.gc });
  let final;
  try {
    Y.applyUpdate(base, original);
    base.clientID = unusedClientId(base, document.clientID);
    const scene = seedScene(base, 3_000, assetUrl);
    const baseline = validateDocument(base, DEFAULT_LIMITS);
    assert.ok(baseline.byteLength < UPPER_DOCUMENT_TARGET, "Base scene already exceeds the upper fixture target");
    const ids = Array.from({ length: PATH_COUNT }, (_entry, slot) => idAt(VISIBLE_OBJECTS + 7 + slot * 10));
    for (const id of ids) {
      const layer = base.getMap("layers").get(id);
      assert.ok(layer instanceof Y.Map && layer.get("type") === LayerType.Path &&
        layer.get("x") >= 5_000 && layer.get("y") >= 5_000, "Padding must use existing offscreen paths");
    }
    const points = ids.map((_id, slot) => pathPoints(slot));
    const clientId = unusedClientId(base, document.clientID);
    const candidate = (count) => {
      const copy = new Y.Doc({ gc: document.gc });
      try {
        Y.applyUpdate(copy, baseline);
        copy.clientID = clientId;
        copy.transact(() => {
          let remaining = count;
          ids.forEach((id, slot) => {
            const size = Math.min(MAX_POINTS, remaining - 2 * (PATH_COUNT - slot - 1));
            copy.getMap("layers").get(id).set("points", points[slot].slice(0, size));
            remaining -= size;
          });
          assert.equal(remaining, 0);
        }, "upper-document-fixture");
        return Y.encodeStateAsUpdate(copy);
      } finally { copy.destroy(); }
    };
    let low = PATH_COUNT * 2;
    let high = PATH_COUNT * MAX_POINTS;
    assert.ok(candidate(high).byteLength > UPPER_DOCUMENT_TARGET, "Four valid paths cannot reach the upper target");
    let best;
    let pointCount = 0;
    while (low <= high) {
      const count = Math.floor((low + high) / 2);
      const state = candidate(count);
      if (state.byteLength <= UPPER_DOCUMENT_TARGET) {
        best = state; pointCount = count; low = count + 1;
      } else high = count - 1;
    }
    assert.ok(best, "No upper fixture candidate fits the document budget");
    final = new Y.Doc({ gc: document.gc });
    Y.applyUpdate(final, best);
    const validated = validateDocument(final, DEFAULT_LIMITS);
    const budget = upperDocumentBudget(validated.byteLength);
    assert.deepEqual(Y.encodeStateAsUpdate(document), original, "Offline fixture generation changed its source");
    return { scene, update: Y.encodeStateAsUpdate(final, vector), metadata: { profile: "upper-document", ...budget,
      paddedPathIds: ids, paddedPointCount: pointCount, maxPointsPerPath: MAX_POINTS,
      strictValidation: true, validationLimits: "DEFAULT_LIMITS", coordinateEncoding: "float64" } };
  } finally { final?.destroy(); base.destroy(); }
}
