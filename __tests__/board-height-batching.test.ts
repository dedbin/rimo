// @vitest-environment node
import * as Y from "yjs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLayer } from "@/lib/board/model";
import { BoardDocument } from "@/lib/collaboration/document";
import { LayerType } from "@/types/board-canvas";

const color = { r: 0, g: 0, b: 0 };
const boards: BoardDocument[] = [];
let frames: Map<number, FrameRequestCallback>;
let request: ReturnType<typeof vi.fn>;

function setup(count = 1): { board: BoardDocument; ids: string[] } {
  const board = new BoardDocument(); boards.push(board);
  const ids = board.insert(Array.from({ length: count }, (_, index) => createLayer(
    index % 2 ? LayerType.Sticker : LayerType.Text, { x: index * 100, y: 0 }, color,
  )));
  board.undoManager.clear();
  return { board, ids };
}
function flushFrame(): void {
  const callbacks = [...frames.values()]; frames.clear();
  callbacks.forEach((callback) => callback(0));
}
beforeEach(() => {
  frames = new Map(); let next = 0;
  request = vi.fn((callback: FrameRequestCallback) => { frames.set(++next, callback); return next; });
  vi.stubGlobal("requestAnimationFrame", request);
  vi.stubGlobal("cancelAnimationFrame", (id: number) => { frames.delete(id); });
});
afterEach(() => { boards.forEach((board) => board.destroy()); boards.length = 0; vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("board-level measured height batching", () => {
  it("persists 50 measurements in one Y update and one transaction outside local undo", () => {
    const { board, ids } = setup(50);
    const updates = vi.fn(); const transactions: Y.Transaction[] = [];
    board.doc.on("update", updates);
    board.doc.on("afterTransaction", (transaction) => { if (transaction.changed.size) transactions.push(transaction); });
    ids.forEach((id, index) => board.setMeasuredTextHeight(id, 120 + index));
    board.setMeasuredTextHeight(ids[0], 180);
    expect(request).toHaveBeenCalledOnce();
    expect(updates).not.toHaveBeenCalled(); expect(board.getLayer(ids[0])?.height).toBe(100);
    flushFrame();
    expect(updates).toHaveBeenCalledOnce(); expect(transactions).toHaveLength(1);
    expect(board.isLocalOrigin(transactions[0].origin)).toBe(true);
    expect(board.undoManager.undoStack).toHaveLength(0);
    expect(board.getLayer(ids[0])?.height).toBe(180);
    expect(board.getLayer(ids[49])?.height).toBe(169);
    board.undo(); expect(board.getLayer(ids[0])?.height).toBe(180);
    const peer = new BoardDocument(); boards.push(peer);
    Y.applyUpdate(peer.doc, Y.encodeStateAsUpdate(board.doc), "remote");
    ids.forEach((id) => expect(peer.getLayer(id)?.height).toBe(board.getLayer(id)?.height));
  });

  it("takes the last measurement and drops a pending change that returns to the stored height", () => {
    const { board, ids: [id] } = setup(); const updates = vi.fn(); board.doc.on("update", updates);
    board.setMeasuredTextHeight(id, 120); board.setMeasuredTextHeight(id, 140);
    flushFrame(); expect(board.getLayer(id)?.height).toBe(140); expect(updates).toHaveBeenCalledOnce();
    updates.mockClear();
    board.setMeasuredTextHeight(id, 160); board.setMeasuredTextHeight(id, 140);
    expect(frames.size).toBe(0); flushFrame(); expect(updates).not.toHaveBeenCalled();
  });

  it("cancels pending measurements on demotion and does not replay them after access returns", () => {
    const { board, ids: [id] } = setup(); const updates = vi.fn(); board.doc.on("update", updates);
    board.setMeasuredTextHeight(id, 120); expect(frames.size).toBe(1);
    board.setWritable(false); expect(frames.size).toBe(0);
    board.setWritable(true); flushFrame(); expect(updates).not.toHaveBeenCalled();
    expect(board.getLayer(id)?.height).toBe(100);
    board.setMeasuredTextHeight(id, 130); flushFrame(); expect(board.getLayer(id)?.height).toBe(130);
  });

  it("cancels pending measurements permanently when the board is destroyed", () => {
    const { board, ids: [id] } = setup(); const updates = vi.fn(); board.doc.on("update", updates);
    board.setMeasuredTextHeight(id, 120); board.destroy();
    expect(frames.size).toBe(0); flushFrame(); expect(updates).not.toHaveBeenCalled();
    board.setWritable(true); board.setMeasuredTextHeight(id, 140);
    expect(board.canEdit).toBe(false); expect(frames.size).toBe(0);
  });

  it("drops stale measurements after a peer height update, even if measured again before flush", () => {
    const { board, ids: [id] } = setup();
    const peer = new BoardDocument(); boards.push(peer);
    Y.applyUpdate(peer.doc, Y.encodeStateAsUpdate(board.doc), "remote");
    board.setMeasuredTextHeight(id, 120);
    peer.update([id], { height: 220 });
    Y.applyUpdate(board.doc, Y.encodeStateAsUpdate(peer.doc), "remote");
    board.setMeasuredTextHeight(id, 130);
    const updates = vi.fn(); board.doc.on("update", updates);
    flushFrame(); expect(board.getLayer(id)?.height).toBe(220); expect(updates).not.toHaveBeenCalled();
  });

  it("never recreates a deleted layer or applies a measurement to a replacement with the same ID", () => {
    const { board, ids: [deleted, replaced] } = setup(2);
    board.setMeasuredTextHeight(deleted, 120); board.setMeasuredTextHeight(replaced, 140);
    board.doc.transact(() => {
      board.layers.delete(deleted);
      board.layers.set(replaced, new Y.Map(Object.entries(board.getLayer(replaced)!)));
    }, "remote");
    const updates = vi.fn(); board.doc.on("update", updates);
    flushFrame();
    expect(board.getLayer(deleted)).toBeUndefined(); expect(board.getLayer(replaced)?.height).toBe(100);
    expect(updates).not.toHaveBeenCalled();
  });

  it("uses a 16 ms timer when requestAnimationFrame is unavailable", async () => {
    vi.stubGlobal("requestAnimationFrame", undefined); vi.stubGlobal("cancelAnimationFrame", undefined); vi.useFakeTimers();
    const { board, ids: [id] } = setup(); const updates = vi.fn(); board.doc.on("update", updates);
    board.setMeasuredTextHeight(id, 120); board.setMeasuredTextHeight(id, 130);
    await vi.advanceTimersByTimeAsync(15); expect(updates).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1); expect(updates).toHaveBeenCalledOnce(); expect(board.getLayer(id)?.height).toBe(130);
    board.setMeasuredTextHeight(id, 160); board.setWritable(false);
    await vi.advanceTimersByTimeAsync(16); expect(updates).toHaveBeenCalledOnce();
  });
});
