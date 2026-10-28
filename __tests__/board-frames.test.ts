import { describe, expect, it } from "vitest";
import * as Y from "yjs";

import { initializeDocument, validateDocument } from "@/collaboration-server/document";
import { DEFAULT_LIMITS } from "@/collaboration-server/types";
import { BoardDocument } from "@/lib/collaboration/document";
import { parseFrame } from "@/lib/board/frames";

const frame = { name: "Урок", x: -100, y: 20, width: 640, height: 480 };

function createBoard(): BoardDocument {
  const doc = new Y.Doc();
  initializeDocument(doc);
  return new BoardDocument(doc);
}

function sync(first: BoardDocument, second: BoardDocument): void {
  Y.applyUpdate(second.doc, Y.encodeStateAsUpdate(first.doc));
  Y.applyUpdate(first.doc, Y.encodeStateAsUpdate(second.doc));
}

describe("persistent page regions", () => {
  it("keeps a peer's region when undoing a local creation", () => {
    const first = createBoard();
    const second = new BoardDocument();
    const own = first.createFrame(frame)!;
    sync(first, second);
    const peer = second.createFrame({ ...frame, name: "Домашняя работа", x: 600 })!;
    sync(second, first);
    first.undo();
    sync(first, second);
    expect(second.getSnapshot().frameIds).toEqual([peer]);
    expect(first.getSnapshot().frames.has(own)).toBe(false);
    first.redo();
    sync(first, second);
    expect(second.getSnapshot().frames.size).toBe(2);
    first.destroy();
    second.destroy();
  });

  it("keeps named page order through a binary snapshot and a fresh Y.Doc", () => {
    const board = createBoard();
    const lesson = board.createFrame(frame)!;
    const homework = board.createFrame({ ...frame, name: "Домашняя работа" })!;
    board.updateFrame(lesson, { name: "Задача 1" });
    board.reorderFrames([homework, lesson, homework]);
    const restored = new Y.Doc();
    Y.applyUpdate(restored, validateDocument(board.doc, DEFAULT_LIMITS));
    const restoredBoard = new BoardDocument(restored);
    expect(restoredBoard.getSnapshot().frameIds).toEqual([homework, lesson]);
    expect(restoredBoard.getSnapshot().frames.get(lesson)).toEqual({ ...frame, name: "Задача 1" });
    board.destroy();
    restoredBoard.destroy();
  });

  it("does not let a read-only client mutate page regions", () => {
    const board = createBoard();
    const id = board.createFrame(frame)!;
    board.setWritable(false);
    expect(board.createFrame(frame)).toBeNull();
    board.updateFrame(id, { name: "Changed" });
    board.removeFrame(id);
    expect(board.getSnapshot().frames.get(id)).toEqual(frame);
    board.destroy();
  });

  it("merges concurrent renaming and movement without overwriting a peer's untouched fields", () => {
    const first = createBoard();
    const second = new BoardDocument();
    const id = first.createFrame(frame)!;
    sync(first, second);
    first.updateFrame(id, { name: "Задача" });
    second.updateFrame(id, { x: 420 });
    sync(first, second);
    expect(first.getSnapshot().frames.get(id)).toEqual({ ...frame, name: "Задача", x: 420 });
    first.undo();
    sync(first, second);
    expect(second.getSnapshot().frames.get(id)).toEqual({ ...frame, x: 420 });
    first.destroy();
    second.destroy();
  });

  it("rejects invalid geometry and inherited frame fields", () => {
    expect(parseFrame({ ...frame, width: 0 })).toBeNull();
    expect(parseFrame({ ...frame, x: Infinity })).toBeNull();
    expect(parseFrame(Object.create(frame))).toBeNull();
    expect(parseFrame({ ...frame, name: "\u0000bad" })).toBeNull();
    const board = createBoard();
    board.frames.set("bad", new Y.Map(Object.entries({ ...frame, height: -1 })));
    expect(() => validateDocument(board.doc, DEFAULT_LIMITS)).toThrow("Invalid page region");
    board.destroy();
  });
});
