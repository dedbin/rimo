// @vitest-environment node
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

const execute = promisify(execFile);

describe("upper-document network fixture without service or browser", () => {
  it("builds one deterministic valid update near 5 MiB, preserves the scene and leaves room for twenty move/undo pairs", async () => {
    // Source .ts modules run through the same tsx/CommonJS boundary as the real
    // network runner; this isolated CPU-only process keeps one Yjs constructor.
    const source = String.raw`
      import assert from "node:assert/strict";
      import { createRequire } from "node:module";
      import { Y } from "./scripts/performance/common.mjs";
      import { idAt, seedScene, SELECT_BOX, VIEWPORT } from "./scripts/performance/fixture.mjs";
      import { prepareUpperFixture, upperDocumentBudget, validateUpperDocument,
        UPPER_DOCUMENT_LIMIT, UPPER_DOCUMENT_RESERVE, UPPER_DOCUMENT_TARGET, UPPER_DOCUMENT_TOLERANCE }
        from "./scripts/performance/network/upper-fixture.mjs";

      const require = createRequire(import.meta.url);
      const { initializeDocument, validateDocument } = require("./collaboration-server/document.ts");
      const { DEFAULT_LIMITS } = require("./collaboration-server/types.ts");
      const { intersectsViewport } = require("./lib/board/geometry.ts");
      const { getRichTextJson } = require("./lib/board/rich-text/document.ts");
      const { pickLayersInBox } = require("./lib/utils.ts");
      const { LayerType } = require("./types/board-canvas.ts");

      const document = new Y.Doc();
      const reference = new Y.Doc();
      let overflow;
      let invalid;
      let history;
      try {
        document.clientID = 12345;
        initializeDocument(document);
        initializeDocument(reference);
        const asset = "/api/assets/upper-fixture";
        const original = Y.encodeStateAsUpdate(document);
        const originalRoots = [...document.share.keys()];
        let updates = 0;
        document.on("update", () => { updates += 1; });
        const prepared = prepareUpperFixture(document, asset);
        assert.equal(updates, 0);
        assert.deepEqual(Y.encodeStateAsUpdate(document), original);
        assert.deepEqual([...document.share.keys()], originalRoots);
        const repeated = prepareUpperFixture(document, asset);
        assert.deepEqual(repeated.update, prepared.update);
        assert.deepEqual(repeated.metadata, prepared.metadata);
        Y.applyUpdate(document, prepared.update);
        assert.equal(updates, 1);
        const bytes = validateUpperDocument(document);
        assert.equal(bytes, prepared.metadata.actualDocumentBytes);
        assert.equal(prepared.metadata.strictValidation, true);
        assert.equal(prepared.metadata.validationLimits, "DEFAULT_LIMITS");
        assert.equal(DEFAULT_LIMITS.maxDocumentBytes, 5 * 1024 * 1024);
        assert.equal(UPPER_DOCUMENT_TARGET, UPPER_DOCUMENT_LIMIT - 64 * 1024);
        assert.ok(bytes >= UPPER_DOCUMENT_TARGET - 64 && bytes <= UPPER_DOCUMENT_TARGET);
        assert.ok(UPPER_DOCUMENT_LIMIT - bytes >= UPPER_DOCUMENT_RESERVE);

        const normal = seedScene(reference, 3_000, asset);
        assert.equal(prepared.scene.objects, 3_000);
        assert.equal(prepared.scene.visibleObjects, 500);
        assert.deepEqual(prepared.scene.distribution, normal.distribution);
        assert.deepEqual(prepared.scene.visibleDistribution, { 0: 250, 1: 100, 2: 50, 4: 50, 5: 50 });
        assert.deepEqual(prepared.scene.positions, normal.positions);
        const layers = document.getMap("layers");
        const expectedLayers = reference.getMap("layers");
        const padded = new Set(prepared.metadata.paddedPathIds);
        assert.equal(layers.size, 3_000);
        assert.equal(padded.size, 4);
        assert.deepEqual(prepared.metadata.paddedPathIds, [507, 517, 527, 537].map(idAt));
        let pointCount = 0;
        for (const [id, layer] of layers) {
          const actual = layer.toJSON();
          const expected = expectedLayers.get(id).toJSON();
          if (padded.has(id)) {
            assert.equal(actual.type, LayerType.Path);
            assert.ok(actual.x >= 5_000 && actual.y >= 5_000);
            assert.ok(actual.points.length >= 2 && actual.points.length <= 50_000);
            assert.ok(actual.points.every(point => point.length === 3 && point.every(value => Number.isFinite(value) && Math.fround(value) !== value)));
            assert.ok(actual.points.every(([x, y, pressure]) => x >= 0 && x <= actual.width && y >= 0 && y <= actual.height && pressure >= 0 && pressure <= 1));
            pointCount += actual.points.length;
            assert.deepEqual({ ...actual, points: expected.points }, expected);
          } else assert.deepEqual(actual, expected);
          if (actual.type === LayerType.Text) assert.deepEqual(getRichTextJson(document, id), getRichTextJson(reference, id));
        }
        assert.equal(pointCount, prepared.metadata.paddedPointCount);
        const plain = new Map([...layers].map(([id, layer]) => [id, layer.toJSON()]));
        assert.equal([...plain.values()].filter(layer => intersectsViewport(layer, { x: 0, y: 0, scale: 1 }, VIEWPORT)).length, 500);
        assert.equal(pickLayersInBox([...plain.keys()], plain, SELECT_BOX.from, SELECT_BOX.to).length, 500);

        const rect = layers.get(idAt(210));
        const position = prepared.scene.positions.get(idAt(210));
        const origin = {};
        history = new Y.UndoManager(layers, { trackedOrigins: new Set([origin]), captureTimeout: 0 });
        let highestBytes = bytes;
        for (let index = 0; index < 20; index += 1) {
          document.transact(() => { rect.set("x", position.x + 20); rect.set("y", position.y); }, origin);
          highestBytes = Math.max(highestBytes, Y.encodeStateAsUpdate(document).byteLength);
          history.undo();
          assert.equal(rect.get("x"), position.x);
          assert.equal(rect.get("y"), position.y);
          highestBytes = Math.max(highestBytes, Y.encodeStateAsUpdate(document).byteLength);
        }
        assert.ok(highestBytes < UPPER_DOCUMENT_LIMIT);
        assert.ok(validateUpperDocument(document) < UPPER_DOCUMENT_LIMIT);
        for (const [id, position] of prepared.scene.positions) {
          assert.equal(layers.get(id).get("x"), position.x);
          assert.equal(layers.get(id).get("y"), position.y);
        }

        const beforeRejectedClones = Y.encodeStateAsUpdate(document);
        overflow = new Y.Doc(); Y.applyUpdate(overflow, beforeRejectedClones);
        const fullPoints = overflow.getMap("layers").get(prepared.metadata.paddedPathIds[0]).get("points");
        assert.equal(fullPoints.length, 50_000);
        for (const id of padded) overflow.getMap("layers").get(id).set("points", fullPoints);
        assert.ok(Y.encodeStateAsUpdate(overflow).byteLength > UPPER_DOCUMENT_LIMIT);
        assert.throws(() => validateDocument(overflow, DEFAULT_LIMITS), /Board storage limit reached/);
        invalid = new Y.Doc(); Y.applyUpdate(invalid, beforeRejectedClones);
        invalid.getMap("layers").get(prepared.metadata.paddedPathIds[0]).set("points", [...fullPoints, fullPoints[0]]);
        assert.throws(() => validateDocument(invalid, DEFAULT_LIMITS), /Invalid board object/);
        assert.deepEqual(Y.encodeStateAsUpdate(document), beforeRejectedClones);
        assert.throws(() => prepareUpperFixture(document, asset));
        assert.deepEqual(Y.encodeStateAsUpdate(document), beforeRejectedClones);
        for (const valid of [UPPER_DOCUMENT_TARGET, UPPER_DOCUMENT_TARGET - UPPER_DOCUMENT_TOLERANCE]) {
          assert.ok(upperDocumentBudget(valid).actualSlackBytes >= UPPER_DOCUMENT_RESERVE);
        }
        for (const invalid of [0, NaN, Infinity, UPPER_DOCUMENT_TARGET + 1, UPPER_DOCUMENT_TARGET - UPPER_DOCUMENT_TOLERANCE - 1, UPPER_DOCUMENT_LIMIT]) {
          assert.throws(() => upperDocumentBudget(invalid));
        }
        process.stdout.write(JSON.stringify({ actualDocumentBytes: bytes, targetDocumentBytes: UPPER_DOCUMENT_TARGET,
          slackBytes: UPPER_DOCUMENT_LIMIT - bytes, highestBytesAfterMoves: highestBytes, publishedUpdates: 1,
          strictValidation: true, deterministic: true, visibleObjects: 500, images: 50, offscreenPaths: padded.size,
          serverLimitsUnchanged: true, twentyMovesAndUndo: true, budgetBoundariesChecked: true }));
      } finally { history?.destroy(); invalid?.destroy(); overflow?.destroy(); reference.destroy(); document.destroy(); }
    `;
    const result = await execute(process.execPath, ["--import=tsx", "--input-type=module", "-e", source], {
      env: { ...process.env, NODE_OPTIONS: "" }, timeout: 45_000, maxBuffer: 65_536, windowsHide: true,
    }).catch((error: { stderr?: string }) => { throw new Error(error.stderr?.slice(-2_000) ?? "Upper fixture process failed"); });
    expect(result.stderr).toBe("");
    const report = JSON.parse(result.stdout);
    expect(report).toMatchObject({ targetDocumentBytes: 5 * 1024 * 1024 - 64 * 1024, publishedUpdates: 1,
      strictValidation: true, deterministic: true, visibleObjects: 500, images: 50, offscreenPaths: 4,
      serverLimitsUnchanged: true, twentyMovesAndUndo: true, budgetBoundariesChecked: true });
    expect(report.slackBytes).toBeGreaterThanOrEqual(64 * 1024);
    expect(report.slackBytes).toBeLessThanOrEqual(64 * 1024 + 64);
    expect(report.highestBytesAfterMoves).toBeLessThan(5 * 1024 * 1024);
  }, 50_000);

  it("requires explicit service opt-in before calibration, credentials or generating the upper fixture", async () => {
    const failure = await execute(process.execPath, ["--import=tsx", "scripts/performance/network/measure-network.mjs",
      "--upper-document", "--storage-state", "does-not-exist"], {
      env: { ...process.env, NODE_OPTIONS: "" }, timeout: 15_000, windowsHide: true,
    }).then(() => null, (error: { code: number; stdout: string; stderr: string }) => error);
    expect(failure).toMatchObject({ code: 1, stdout: "", stderr: "Network acceptance setup failed.\n" });
  }, 20_000);
});
