import { afterEach, describe, expect, it } from "vitest";
import { Editor } from "@tiptap/core";
import * as Y from "yjs";
import { BoardDocument } from "@/lib/collaboration/document";
import { createLayer } from "@/lib/board/model";
import { LayerType } from "@/types/board-canvas";
import { createTextExtensions } from "@/lib/board/rich-text/extensions";
import { createBoardTextBinding } from "@/lib/board/rich-text/yjs-binding";
import { parseRichTextMarkdown } from "@/lib/board/rich-text/markdown";
import { POSITION_MIGRATION_PREFIX, MAX_POSITION_MIGRATION_RECORDS, positionMigrationLayerId, validatePositionMigrationRoot } from "@/lib/board/rich-text/position-migrations";
import { initializeDocument, validateDocument, validateIncomingUpdate } from "@/collaboration-server/document";
import { DEFAULT_LIMITS } from "@/collaboration-server/types";

const documents: Y.Doc[] = [];
afterEach(() => { documents.forEach((doc) => doc.destroy()); documents.length = 0; });
const root = `${POSITION_MIGRATION_PREFIX}text:layer`;

function fixture(value: unknown, key = "1:10") {
  const doc = new Y.Doc(); documents.push(doc);
  doc.getXmlFragment("text:layer");
  doc.getMap(root).set(key, value);
  return doc;
}
function migration(fragmentName = "text:layer") {
  return { version: 1, client: 1, clock: 10, seen: [[1, 10]], transfers: [
    { source: { client: 1, clock: 0, length: 1 }, target: { client: 1, clock: 5, type: { client: 1, clock: 2 } } },
    { source: { client: 1, clock: 2, length: 1, boundary: "start" },
      target: { client: 1, clock: 5, type: null, tname: fragmentName, assoc: -1, boundary: "end" } },
  ] };
}

describe("pinned Tiptap position metadata contract", () => {
  it("accepts real structural-edit metadata produced by the public ySync binding", () => {
    const board = new BoardDocument();
    const [id] = board.insert([{ ...createLayer(LayerType.Text, { x: 0, y: 0 }, { r: 0, g: 0, b: 0 }), value: "Начало" }]);
    const editor = new Editor({ element: document.createElement("div"), extensions: [
      ...createTextExtensions(), createBoardTextBinding({ fragment: board.getTextFragment(id), history: board, canEdit: () => true }),
    ] });
    try {
      editor.commands.setContent(parseRichTextMarkdown("## Задача\n\nНовый **текст**\n\n1. Один\n2. Два"));
      const names = [...board.doc.share.keys()].filter((name) => positionMigrationLayerId(name) !== null);
      expect(names).toHaveLength(1);
      expect(validatePositionMigrationRoot(board.doc, names[0]).records).toBeGreaterThan(0);
      const restored = new Y.Doc(); documents.push(restored);
      Y.applyUpdate(restored, Y.encodeStateAsUpdate(board.doc));
      expect(validatePositionMigrationRoot(restored, names[0]).records).toBeGreaterThan(0);
    } finally { editor.destroy(); board.destroy(); }
  });

  it("accepts typed positions and returns bounded aggregate counts", () => {
    expect(validatePositionMigrationRoot(fixture(migration()), root)).toEqual({ records: 1, transfers: 2, causalEntries: 1 });
  });

  it("rejects unknown namespaces, missing fragment roots and non-map metadata", () => {
    expect(positionMigrationLayerId("__tiptap_position_migrations:item:1:2")).toBeNull();
    const doc = new Y.Doc(); documents.push(doc);
    doc.getMap(root);
    expect(() => validatePositionMigrationRoot(doc, root)).toThrow();
    const wrong = new Y.Doc(); documents.push(wrong);
    wrong.getXmlFragment("text:layer"); wrong.getArray(root).push([migration()]);
    expect(() => validatePositionMigrationRoot(wrong, root)).toThrow();
  });

  it("rejects malformed IDs, cross-fragment targets, unsafe numbers and prototype-bearing entries", () => {
    const good = migration();
    const invalid = [
      { ...good, client: -1 }, { ...good, clock: Infinity }, { ...good, version: 2 },
      { ...good, seen: [[1, 1], [1, 2]] }, { ...good, extra: true }, Object.create(good),
      { ...good, transfers: [{ source: { client: 1, clock: 0, length: 0 }, target: null }] },
      { ...good, transfers: [{ source: { client: 1, clock: Number.MAX_SAFE_INTEGER, length: 1 }, target: null }] },
      { ...good, transfers: [{ source: { client: 1, clock: 0, length: 1 }, target: { client: 1, clock: 2, type: null, tname: "layers" } }] },
    ];
    for (const value of invalid) expect(() => validatePositionMigrationRoot(fixture(value), root)).toThrow();
    expect(() => validatePositionMigrationRoot(fixture(good, "wrong-key"), root)).toThrow();
  });

  it("rejects a migration store that exceeds the record budget", () => {
    const doc = fixture(migration());
    doc.transact(() => {
      for (let clock = 20; clock <= MAX_POSITION_MIGRATION_RECORDS + 20; clock += 1) {
        doc.getMap(root).set(`1:${clock}`, { ...migration(), clock });
      }
    });
    expect(() => validatePositionMigrationRoot(doc, root)).toThrow();
  });

  it("allows new records while refusing valid replacements and deletions without changing the canonical document", () => {
    const board = new BoardDocument();
    try {
      initializeDocument(board.doc);
      const [id] = board.insert([{ ...createLayer(LayerType.Text, { x: 0, y: 0 }, { r: 0, g: 0, b: 0 }), value: "Текст" }]);
      const name = `${POSITION_MIGRATION_PREFIX}text:${id}`;
      const record = migration(`text:${id}`);
      board.doc.getMap(name).set("1:10", record);
      validateDocument(board.doc, DEFAULT_LIMITS);
      const original = Y.encodeStateAsUpdate(board.doc);
      const changes = [
        (store: Y.Map<unknown>) => store.set("1:10", { ...record, seen: [[1, 11]] }),
        (store: Y.Map<unknown>) => store.delete("1:10"),
      ];
      for (const change of changes) {
        const peer = new Y.Doc(); documents.push(peer);
        Y.applyUpdate(peer, original);
        const vector = Y.encodeStateVector(peer);
        change(peer.getMap(name));
        expect(() => validateDocument(peer, DEFAULT_LIMITS)).not.toThrow();
        expect(() => validateIncomingUpdate(board.doc, Y.encodeStateAsUpdate(peer, vector), DEFAULT_LIMITS)).toThrow("append-only");
        expect(Y.encodeStateAsUpdate(board.doc)).toEqual(original);
      }
      const peer = new Y.Doc(); documents.push(peer);
      Y.applyUpdate(peer, original);
      const vector = Y.encodeStateVector(peer);
      peer.getMap(name).set("1:20", { ...record, clock: 20 });
      const append = Y.encodeStateAsUpdate(peer, vector);
      expect(() => validateIncomingUpdate(board.doc, append, DEFAULT_LIMITS)).not.toThrow();
      expect(Y.encodeStateAsUpdate(board.doc)).toEqual(original);
      Y.applyUpdate(board.doc, append);
      expect(board.doc.getMap(name).size).toBe(2);
    } finally { board.destroy(); }
  });
});
