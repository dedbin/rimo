import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import { pdfFixture } from "../../../__tests__/pdf-fixtures.ts";
import { getRichTextJson, writeRichTextFragment } from "../../../lib/board/rich-text/document.ts";
import { api, fail, Y } from "../common.mjs";
import { idAt, seedScene } from "../fixture.mjs";

const OFFSET = Object.freeze({ x: 10_000, y: 10_000 });
const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

export async function controlImage(owner, boardId) {
  const asset = pdfFixture().assets[0];
  const response = await owner.post(`/api/boards/${boardId}/assets`, { multipart: {
    file: { name: "pdf-control.webp", mimeType: "image/webp", buffer: Buffer.from(asset.data, "base64") },
  } });
  if (!response.ok()) throw fail(`Control asset upload returned HTTP ${response.status()}`);
  return (await response.json()).asset.url;
}

export function seedLesson(document, baseAssetUrl, controlAssetUrl) {
  const scene = seedScene(document, 3_000, baseAssetUrl);
  const source = pdfFixture(20);
  const layers = document.getMap("layers");
  const positions = new Map(scene.positions);
  const controlHashes = new Map();
  const replaced = [];
  document.transact(() => {
    for (const [index, item] of source.layers.entries()) {
      const id = idAt(2_990 + index);
      const layer = { ...item.layer, x: OFFSET.x + item.layer.x, y: OFFSET.y + item.layer.y };
      if ("src" in layer) layer.src = controlAssetUrl;
      layers.set(id, new Y.Map(Object.entries(layer)));
      positions.set(id, { x: layer.x, y: layer.y });
      if (item.richText) {
        writeRichTextFragment(document.getXmlFragment(`text:${id}`), item.richText);
        controlHashes.set(id, hash(getRichTextJson(document, id)));
      }
      replaced.push(id);
    }
    for (const [index, page] of source.pages.entries()) {
      const id = `pdf-control-${String(index).padStart(2, "0")}`;
      document.getMap("frames").set(id, new Y.Map(Object.entries({ name: page.name, ...page.bounds, x: OFFSET.x, y: OFFSET.y })));
      document.getArray("frameIds").push([id]);
    }
  }, "pdf-lesson-control-fixture");
  const actualDistribution = {};
  for (const item of layers.values()) actualDistribution[item.get("type")] = (actualDistribution[item.get("type")] ?? 0) + 1;
  const pages = source.pages.map((page, index) => ({ source: { type: "frame", frameId: `pdf-control-${String(index).padStart(2, "0")}` },
    format: page.format, orientation: page.orientation }));
  return { ...scene, positions, controlHashes, pages, summary: { baseSceneVersion: scene.sceneVersion, objects: layers.size,
    visibleObjects: scene.visibleObjects, baseDistribution: scene.distribution, actualDistribution, visibleDistribution: scene.visibleDistribution,
    replacedOffscreenIds: replaced, controlOrigin: OFFSET, frames: 20, controlObjectsPerPage: 7, uniqueBoardImages: 2,
    protocol: "R08 scene1 with seven offscreen replacements; R09 control fixture repeated on 20 named frames" } };
}

export function auditLesson(document, scene) {
  assert.equal(document.getMap("layers").size, 3_000);
  for (const [id, original] of scene.positions) {
    const layer = document.getMap("layers").get(id);
    assert.equal(layer.get("x"), original.x); assert.equal(layer.get("y"), original.y);
  }
  assert.equal(document.getMap("frames").size, 20);
  assert.deepEqual(document.getArray("frameIds").toArray(), scene.pages.map((page) => page.source.frameId));
  for (const [id, expected] of scene.controlHashes) assert.equal(hash(getRichTextJson(document, id)), expected);
  return { originalCoordinatesRestored: true, controlContentRestored: true };
}

export async function prepareSnapshot(owner, boardId, scene, minimumRevision) {
  const prepared = await api(owner, "POST", `/api/boards/${boardId}/pdf/preview`, { minimumRevision, pages: scene.pages });
  if (prepared.pages?.length !== 20 || !Number.isSafeInteger(prepared.revision)) throw fail("Public PDF preview did not create the fixed 20-page snapshot");
  return prepared;
}
