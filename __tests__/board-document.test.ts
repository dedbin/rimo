import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { BoardDocument } from "@/lib/collaboration/document";
import { createLayer, normalizeLayerOrder, parseLayer } from "@/lib/board/model";
import { LayerType } from "@/types/board-canvas";
import { matchesPersistedSnapshot } from "@/lib/collaboration/save-state";

const rectangle = (x = 0) => createLayer(LayerType.Rectangle, { x, y: 0 }, { r: 0, g: 0, b: 0 });
const sync = (source: BoardDocument, target: BoardDocument) => {
  Y.applyUpdate(target.doc, Y.encodeStateAsUpdate(source.doc), "remote");
};

describe("board document collaboration", () => {
  it("merges simultaneous edits to different fields of the same layer", () => {
    const first = new BoardDocument();
    const second = new BoardDocument();
    const [id] = first.insert([rectangle()]);
    sync(first, second);
    first.update([id], { fill: { r: 255, g: 0, b: 0 } });
    second.translate([id], { x: 40, y: 50 });
    sync(first, second);
    sync(second, first);
    expect(first.getLayer(id)).toMatchObject({ x: 40, y: 50, fill: { r: 255, g: 0, b: 0 } });
    expect(second.getLayer(id)).toEqual(first.getLayer(id));
    first.destroy(); second.destroy();
  });

  it("undoes a complete 500-object move once without undoing another author", () => {
    const first = new BoardDocument();
    const second = new BoardDocument();
    const ids = first.insert(Array.from({ length: 500 }, (_, index) => rectangle(index)));
    sync(first, second);
    first.translate(ids, { x: 100, y: 200 });
    second.update([ids[0]], { fill: { r: 1, g: 2, b: 3 } });
    sync(second, first);
    first.undo();
    expect(first.getLayer(ids[0])).toMatchObject({ x: 0, y: 0, fill: { r: 1, g: 2, b: 3 } });
    expect(first.getLayer(ids[499])).toMatchObject({ x: 499, y: 0 });
    first.redo();
    expect(first.getLayer(ids[499])).toMatchObject({ x: 599, y: 200 });
    first.destroy(); second.destroy();
  });

  it("emits one document update for a group gesture", () => {
    const board = new BoardDocument();
    const ids = board.insert(Array.from({ length: 500 }, (_, index) => rectangle(index)));
    let updates = 0;
    board.doc.on("update", () => { updates += 1; });
    board.translate(ids, { x: 1, y: 1 });
    expect(updates).toBe(1);
    board.destroy();
  });

  it("rejects mutations and history actions in viewer mode", () => {
    const board = new BoardDocument();
    const [id] = board.insert([rectangle()]);
    const initial = Y.encodeStateAsUpdate(board.doc);
    board.setWritable(false);
    board.update([id], { x: 99 });
    board.remove([id]);
    board.insert([rectangle()]);
    board.translate([id], { x: 5, y: 5 });
    board.reorder([id], "front");
    board.undo();
    expect(Y.encodeStateAsUpdate(board.doc)).toEqual(initial);
    board.destroy();
  });

  it("does not recreate a layer deleted by a peer during a drag", () => {
    const first = new BoardDocument();
    const second = new BoardDocument();
    const [id] = first.insert([rectangle()]);
    sync(first, second);
    second.remove([id]);
    sync(second, first);
    first.translate([id], { x: 10, y: 10 });
    expect(first.getLayer(id)).toBeUndefined();
    expect(first.getSnapshot().layerIds).toEqual([]);
    first.destroy(); second.destroy();
  });

  it("stores independent copies of mutable input objects", () => {
    const board = new BoardDocument();
    const input = rectangle();
    const [id] = board.insert([input]);
    input.x = 999;
    input.fill!.r = 255;
    expect(board.getLayer(id)).toMatchObject({ x: 0, fill: { r: 0 } });
    board.destroy();
  });

  it("keeps layer snapshots stable when an unrelated layer changes", () => {
    const board = new BoardDocument();
    const [first, second] = board.insert([rectangle(), rectangle(100)]);
    const before = board.getLayer(first);
    board.update([second], { x: 200 });
    expect(board.getLayer(first)).toBe(before);
    board.destroy();
  });
});

describe("document validation and persistence acknowledgement", () => {
  it("requires a new commit acknowledgement after deletion even if the state vector is unchanged", () => {
    const board = new BoardDocument();
    const [id] = board.insert([rectangle()]);
    const committed = Y.snapshot(board.doc);
    const vector = Y.encodeStateVector(board.doc);
    expect(matchesPersistedSnapshot(board.doc, committed)).toBe(true);
    board.remove([id]);
    expect(Y.encodeStateVector(board.doc)).toEqual(vector);
    expect(matchesPersistedSnapshot(board.doc, committed)).toBe(false);
    expect(matchesPersistedSnapshot(board.doc, Y.snapshot(board.doc))).toBe(true);
    board.destroy();
  });

  it("normalizes concurrent order duplicates, missing IDs and unordered layers", () => {
    const layers = new Map([["a", rectangle()], ["b", rectangle()], ["c", rectangle()]]);
    expect(normalizeLayerOrder(["b", "a", "b", "missing"], layers)).toEqual(["b", "a", "c"]);
  });

  it("rejects transient and external image references and invalid coordinates", () => {
    const image = { type: LayerType.Image, x: 0, y: 0, width: 10, height: 10 };
    for (const src of ["blob:temporary", "data:image/png;base64,abc", "https://external.test/image.png", "/api/assets/../secret"]) {
      expect(parseLayer({ ...image, src })).toBeNull();
    }
    expect(parseLayer({ ...image, src: "/api/assets/asset_123" })).not.toBeNull();
    expect(parseLayer({ ...rectangle(), x: Infinity })).toBeNull();
  });
});
