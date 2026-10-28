// @vitest-environment node
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

const execute = promisify(execFile);

describe("synthetic two-writer history fixture", () => {
  it("grows real CRDT history within a target while preserving every layer, XML, asset and scene position", async () => {
    const source = String.raw`
      import assert from "node:assert/strict";
      import { createRequire } from "node:module";
      import { Y } from "./scripts/performance/common.mjs";
      import { seedScene, VIEWPORT } from "./scripts/performance/fixture.mjs";
      import { MAX_HISTORY_TARGET, MAX_HISTORY_CYCLES, prepareHistoryFixture } from "./scripts/performance/history-fixture.mjs";
      const require = createRequire(import.meta.url);
      const { initializeDocument, validateDocument } = require("./collaboration-server/document.ts");
      const { DEFAULT_LIMITS } = require("./collaboration-server/types.ts");
      const { getRichTextJson } = require("./lib/board/rich-text/document.ts");
      const { intersectsViewport } = require("./lib/board/geometry.ts");
      const { LayerType } = require("./types/board-canvas.ts");
      const document = new Y.Doc({ gc: true }), restored = new Y.Doc({ gc: true });
      try {
        initializeDocument(document); seedScene(document, 3000, "/api/assets/owned-history-fixture");
        const layers = () => [...document.getMap("layers")].map(([id, layer]) => [id, layer.toJSON()]);
        const originalLayers = layers(), order = document.getArray("layerIds").toArray();
        const xml = originalLayers.filter(([, layer]) => layer.type === LayerType.Text).map(([id]) => [id, getRichTextJson(document, id)]);
        const original = validateDocument(document, DEFAULT_LIMITS);
        for (const target of [original.byteLength - 1, MAX_HISTORY_TARGET + 1, NaN]) {
          await assert.rejects(prepareHistoryFixture(document, target));
          assert.deepEqual(Y.encodeStateAsUpdate(document), original);
        }
        const controller = new AbortController(); controller.abort();
        await assert.rejects(prepareHistoryFixture(document, 1_447_218, { signal: controller.signal }));
        assert.deepEqual(Y.encodeStateAsUpdate(document), original);
        const history = await prepareHistoryFixture(document, 1_447_218);
        const final = validateDocument(document, DEFAULT_LIMITS);
        assert.ok(final.byteLength <= 1_447_218 && final.byteLength > original.byteLength + 500_000);
        assert.ok(history.targetUndershootBytes < 128 * 1024);
        assert.ok(history.after.structs > history.before.structs + 10_000);
        assert.ok(history.after.deletedStructs > history.before.deletedStructs + 10_000);
        assert.equal(new Set(history.writerClientIds).size, 2);
        assert.equal(history.after.clients, history.before.clients + 2);
        assert.ok(history.writerClientIds.every((id) => document.store.clients.has(id)));
        assert.equal(history.batchSize, 500); assert.ok(history.acceptedCycles > 0);
        assert.equal(history.acceptedTransactions, history.acceptedCycles * 4);
        assert.ok(history.attemptedCycles <= MAX_HISTORY_CYCLES);
        assert.equal(history.generationBound.transactions, MAX_HISTORY_CYCLES * 4);
        assert.equal(history.coordinatesRestored, true); assert.equal(history.rawReplay, false);
        assert.equal(history.strictValidation, true); assert.equal(history.gc, true);
        assert.match(history.generatorSha256, /^[a-f0-9]{64}$/);
        assert.deepEqual(layers(), originalLayers);
        assert.deepEqual(document.getArray("layerIds").toArray(), order);
        for (const [id, value] of xml) assert.deepEqual(getRichTextJson(document, id), value);
        assert.equal(originalLayers.filter(([, layer]) => intersectsViewport(layer, { x: 0, y: 0, scale: 1 }, VIEWPORT)).length, 500);
        assert.equal(originalLayers.filter(([, layer]) => layer.type === LayerType.Image && intersectsViewport(layer, { x: 0, y: 0, scale: 1 }, VIEWPORT)).length, 50);
        Y.applyUpdate(restored, final); assert.deepEqual(validateDocument(restored, DEFAULT_LIMITS), final);
        assert.deepEqual(restored.getArray("layerIds").toArray(), order);
        assert.equal(DEFAULT_LIMITS.maxDocumentBytes, 5 * 1024 * 1024);
        process.stdout.write(JSON.stringify({ profile: history.profile, finalBytes: history.finalBytes, initialBytes: history.initialBytes,
          restoredCoordinates: true, strictValidation: true, rawReplay: false, objects: 3000, visible: 500, images: 50 }));
      } finally { restored.destroy(); document.destroy(); }
    `;
    const result = await execute(process.execPath, ["--import=tsx", "--input-type=module", "-e", source], {
      env: { ...process.env, NODE_OPTIONS: "" }, windowsHide: true, timeout: 30_000, maxBuffer: 65_536,
    }).catch((error: { stderr?: string }) => { throw new Error(error.stderr?.slice(-2000) ?? "History fixture process failed"); });
    expect(result.stderr).toBe("");
    const report = JSON.parse(result.stdout);
    expect(report).toMatchObject({ profile: "synthetic-two-writer-move500-history", restoredCoordinates: true,
      strictValidation: true, rawReplay: false, objects: 3000, visible: 500, images: 50 });
    expect(report.finalBytes).toBeLessThanOrEqual(1_447_218);
    expect(report.finalBytes).toBeGreaterThan(report.initialBytes + 500_000);
  }, 35_000);

  it("rejects an excessive CLI target before reading credentials or contacting a service", async () => {
    await expect(execute(process.execPath, ["--import=tsx", "scripts/load-collaboration.mjs", "--history-bytes", "5242880",
      "--storage-state", "does-not-exist"], { windowsHide: true, timeout: 15_000 }))
      .rejects.toMatchObject({ stderr: expect.stringContaining("history-bytes must be between") });
  }, 20_000);
});
