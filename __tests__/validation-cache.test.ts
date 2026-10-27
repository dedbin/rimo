// @vitest-environment node

import { afterEach, describe, expect, it } from "vitest";
import * as Y from "yjs";

import { initializeDocument, validateDocument } from "../collaboration-server/document";
import { CollaborationRejection, DEFAULT_LIMITS } from "../collaboration-server/types";
import { ValidationCache } from "../collaboration-server/validation-cache";
import { POSITION_MIGRATION_PREFIX } from "../lib/board/rich-text/position-migrations";

const documents: Y.Doc[] = [];

function tracked(document = new Y.Doc()): Y.Doc { documents.push(document); return document; }
function copy(document: Y.Doc): Y.Doc {
  const result = tracked(new Y.Doc({ gc: document.gc }));
  Y.applyUpdate(result, Y.encodeStateAsUpdate(document));
  return result;
}
function rectangle(width = 100): Y.Map<unknown> {
  return new Y.Map<unknown>([["type", 0], ["x", 0], ["y", 0], ["width", width], ["height", 100], ["fill", { r: 0, g: 0, b: 0 }]]);
}
function canonical(): Y.Doc {
  const document = tracked();
  initializeDocument(document);
  document.getMap("layers").set("rectangle", rectangle());
  document.getArray("layerIds").push(["rectangle"]);
  return document;
}
function layer(document: Y.Doc): Y.Map<unknown> {
  return document.getMap<Y.Map<unknown>>("layers").get("rectangle")!;
}
function update(document: Y.Doc, action: () => void): Uint8Array {
  let result: Uint8Array | undefined;
  const capture = (value: Uint8Array) => { result = value; };
  document.on("update", capture);
  document.transact(action);
  document.off("update", capture);
  if (!result) throw new Error("The test operation did not produce an update");
  return result;
}
function noOp(document: Y.Doc): Uint8Array {
  return Y.encodeStateAsUpdate(document, Y.encodeStateVector(document));
}

afterEach(() => documents.splice(0).forEach((document) => document.destroy()));

describe("validation shadow alignment", () => {
  it("reuses a shadow for30 committed updates without mutating the authoritative document during validation", () => {
    const document = canonical();
    const peer = copy(document);
    const cache = new ValidationCache(DEFAULT_LIMITS);
    for (let index = 1; index <= 30; index += 1) {
      const delta = update(peer, () => layer(peer).set("x", index));
      const before = Y.encodeStateAsUpdate(document);
      cache.validate("board", document, delta);
      expect(Y.encodeStateAsUpdate(document)).toEqual(before);
      Y.applyUpdate(document, delta);
    }
    expect(layer(document).get("x")).toBe(30);
    expect(cache.statistics).toEqual({ size: 1, created: 1, reused: 29, rejected: 0 });
    document.destroy();
    expect(cache.statistics.size).toBe(0);
  });

  it("discards a rejected shadow so the next valid operation cannot inherit its invalid contents", () => {
    const document = canonical();
    const attacker = copy(document);
    const valid = copy(document);
    const cache = new ValidationCache(DEFAULT_LIMITS);
    const invalid = update(attacker, () => layer(attacker).set("width", -1));
    expect(() => cache.validate("board", document, invalid)).toThrow(CollaborationRejection);
    expect(cache.statistics.size).toBe(0);
    const delta = update(valid, () => layer(valid).set("y", 42));
    cache.validate("board", document, delta);
    Y.applyUpdate(document, delta);
    expect(layer(document).toJSON()).toMatchObject({ width: 100, y: 42 });
    expect(cache.statistics).toEqual({ size: 1, created: 2, reused: 0, rejected: 1 });
  });

  it("rebuilds after accepted but unapplied updates instead of retaining phantom repairs", () => {
    const document = canonical();
    const peer = copy(document);
    const cache = new ValidationCache(DEFAULT_LIMITS);
    const accepted = update(peer, () => layer(peer).set("width", 200));
    cache.validate("board", document, accepted);
    const independent = copy(document);
    const next = update(independent, () => layer(independent).set("x", 7));
    cache.validate("board", document, next);
    Y.applyUpdate(document, next);
    expect(layer(document).toJSON()).toMatchObject({ x: 7, width: 100 });
    expect(cache.statistics.created).toBe(2);
  });

  it.each(["pending-structs", "pending-delete-set"])("does not let an aborted %s repair mask a later invalid update", (kind) => {
    const document = canonical();
    const peer = copy(document);
    const cache = new ValidationCache(DEFAULT_LIMITS);
    const invalid = update(peer, () => {
      if (kind === "pending-structs") layer(peer).set("width", -1);
      else peer.getMap("layers").set("future", rectangle(-1));
    });
    const repair = update(peer, () => {
      if (kind === "pending-structs") layer(peer).set("width", 200);
      else peer.getMap("layers").delete("future");
    });
    const pending = copy(document);
    Y.applyUpdate(pending, repair);
    expect(Y.equalSnapshots(Y.snapshot(document), Y.snapshot(pending))).toBe(true);
    expect(Y.encodeStateAsUpdate(pending)).not.toEqual(Y.encodeStateAsUpdate(document));
    // The full encoding preserves the unapplied repair while Y.snapshot omits it.
    const roundTrip = copy(pending);
    Y.applyUpdate(roundTrip, invalid);
    expect(() => validateDocument(roundTrip, DEFAULT_LIMITS)).not.toThrow();
    cache.validate("board", document, repair);
    // Simulate abort between beforeSync and canonical apply: repair never reaches document.
    expect(() => cache.validate("board", document, invalid)).toThrow(CollaborationRejection);
    expect(layer(document).get("width")).toBe(100);
    expect(document.getMap("layers").has("future")).toBe(false);
    expect(cache.statistics).toEqual({ size: 0, created: 2, reused: 0, rejected: 1 });
  });

  it("resynchronizes an internal canonical change and rejects an internally invalid canonical", () => {
    const document = canonical();
    const peer = copy(document);
    const cache = new ValidationCache(DEFAULT_LIMITS);
    cache.validate("board", document, noOp(document));
    layer(document).set("x", 90);
    const delta = update(peer, () => layer(peer).set("y", 45));
    cache.validate("board", document, delta);
    Y.applyUpdate(document, delta);
    expect(layer(document).toJSON()).toMatchObject({ x: 90, y: 45 });
    expect(cache.statistics.created).toBe(2);
    layer(document).set("width", -1);
    expect(() => cache.validate("board", document, noOp(document))).toThrow(CollaborationRejection);
    expect(cache.statistics.size).toBe(0);
  });

  it("replaces an identical binary state on a new canonical instance and cleans up on destroy", () => {
    const first = canonical();
    const cache = new ValidationCache(DEFAULT_LIMITS);
    cache.validate("board", first, noOp(first));
    const reopened = copy(first);
    cache.validate("board", reopened, noOp(reopened));
    expect(cache.statistics.created).toBe(2);
    first.destroy();
    expect(cache.statistics.size).toBe(1);
    reopened.destroy();
    expect(cache.statistics.size).toBe(0);
    expect(() => cache.validate("board", reopened, noOp(reopened))).toThrow("closed");
  });

  it("keeps append-only position metadata checks active on reused shadows", () => {
    const document = canonical();
    document.getXmlFragment("text:orphan").insert(0, [new Y.XmlElement("paragraph")]);
    const name = `${POSITION_MIGRATION_PREFIX}text:orphan`;
    const record = { version: 1, client: 1, clock: 10, seen: [[1, 10]], transfers: [] };
    document.getMap(name).set("1:10", record);
    const cache = new ValidationCache(DEFAULT_LIMITS);
    cache.validate("board", document, noOp(document));
    const replacing = copy(document);
    const replacement = update(replacing, () => replacing.getMap(name).set("1:10", { ...record, seen: [[1, 11]] }));
    expect(() => validateDocument(replacing, DEFAULT_LIMITS)).not.toThrow();
    expect(() => cache.validate("board", document, replacement)).toThrow("append-only");
    const appending = copy(document);
    const append = update(appending, () => appending.getMap(name).set("1:20", { ...record, clock: 20 }));
    cache.validate("board", document, append);
    Y.applyUpdate(document, append);
    const deleting = copy(document);
    const removal = update(deleting, () => deleting.getMap(name).delete("1:10"));
    const before = Y.encodeStateAsUpdate(document);
    expect(() => cache.validate("board", document, removal)).toThrow("append-only");
    expect(Y.encodeStateAsUpdate(document)).toEqual(before);
    expect(document.getMap(name).size).toBe(2);
  });

  it("keeps only the configured number of shadows and clears them without changing canonical documents", () => {
    const first = canonical();
    const second = canonical();
    const cache = new ValidationCache({ ...DEFAULT_LIMITS, maxOpenDocuments: 1 });
    cache.validate("first", first, noOp(first));
    cache.validate("second", second, noOp(second));
    expect(cache.statistics.size).toBe(1);
    cache.validate("first", first, noOp(first));
    expect(cache.statistics.created).toBe(3);
    second.destroy();
    expect(cache.statistics.size).toBe(1);
    cache.clear();
    expect(cache.statistics.size).toBe(0);
    expect(layer(first).get("width")).toBe(100);
  });
});
