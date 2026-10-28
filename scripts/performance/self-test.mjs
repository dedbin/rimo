import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { initializeDocument, validateDocument } from "../../collaboration-server/document.ts";
import { DEFAULT_LIMITS } from "../../collaboration-server/types.ts";
import { intersectsViewport } from "../../lib/board/geometry.ts";
import { parseLayer } from "../../lib/board/model.ts";
import { pickLayersInBox } from "../../lib/utils.ts";

import { describeClose, safeError, Y } from "./common.mjs";
import { dragOffset, seedScene, SELECT_BOX, VIEWPORT, VISIBLE_OBJECTS } from "./fixture.mjs";

export function selfTest() {
  const document = new Y.Doc();
  try {
    initializeDocument(document);
    const scene = seedScene(document, 3_000, `/api/assets/${randomUUID()}`);
    const state = validateDocument(document, DEFAULT_LIMITS);
    const layers = new Map([...document.getMap("layers")].map(([id, value]) => [id, parseLayer(value.toJSON())]));
    assert.equal(layers.size, 3_000);
    assert([...layers.values()].every(Boolean));
    assert.equal([...layers.values()].filter((layer) => intersectsViewport(layer, { x: 0, y: 0, scale: 1 }, VIEWPORT)).length, VISIBLE_OBJECTS);
    assert.equal(pickLayersInBox([...layers.keys()], layers, SELECT_BOX.from, SELECT_BOX.to).length, VISIBLE_OBJECTS);
    assert.deepEqual(scene.visibleDistribution, { 0: 250, 1: 100, 2: 50, 4: 50, 5: 50 });
    const offsets = Array.from({ length: 180 }, (_entry, index) => dragOffset(index + 1, 180));
    assert(Math.abs(Math.hypot(offsets[0].x, offsets[0].y) - 4) < 1e-9);
    assert.deepEqual(offsets.at(-1), { x: 120, y: 40 });
    assert.deepEqual(dragOffset(1, 1), { x: 120, y: 40 });
    assert(offsets.every((offset, index) => index === 0 || offset.x > offsets[index - 1].x));
    const secret = randomUUID();
    const message = safeError(new Error(`Request failed\nCall log:\n - cookie: ${secret}`));
    assert.equal(message, "Operation failed");
    assert(!message.includes(secret));
    assert(!safeError(new Error(`Cookie: ${secret}`)).includes(secret));
    assert.deepEqual(describeClose({ code: 1000, reason: "Access revoked or unavailable" }), { code: 1000, reason: "access-unavailable" });
    assert.deepEqual(describeClose({ code: 1008, reason: "Connection receive limit reached" }), { code: 1008, reason: "receive-limit" });
    assert.deepEqual(describeClose({ code: 1000, reason: "Board removed" }), { code: 1000, reason: "board-removed" });
    assert.deepEqual(describeClose({ code: 1000, reason: secret }), { code: 1000, reason: "unclassified" });
    assert.deepEqual(describeClose({}), { code: null, reason: "unspecified" });
    return { kind: "performance-fixture-check", objects: scene.objects, visible: VISIBLE_OBJECTS,
      documentBytes: state.byteLength, distribution: scene.distribution, errorCallLogRedacted: true };
  } finally { document.destroy(); }
}
