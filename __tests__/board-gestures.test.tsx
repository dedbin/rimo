import { ReactNode, PointerEvent } from "react";
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BoardDocument } from "@/lib/collaboration/document";
import { BoardRuntimeContext } from "@/lib/collaboration/react";
import type { BoardRuntime } from "@/lib/collaboration/runtime";
import { emptyPresence } from "@/lib/collaboration/presence";
import type { BoardPresence } from "@/lib/collaboration/presence";
import { createLayer } from "@/lib/board/model";
import { createLine, lineEndpoints } from "@/lib/board/line";
import { BoardCanvasMode, LayerType } from "@/types/board-canvas";
import type { LineLayer } from "@/types/board-canvas";
import { useCanvasGestures } from "@/app/board/[boardId]/_hooks/use-canvas-gestures";

let board: BoardDocument;
let presence: BoardPresence;
let svg: SVGSVGElement;
let runtime: BoardRuntime;
const stateListeners = new Set<() => void>();

function pointer(x: number, y: number, shiftKey = false): PointerEvent<SVGSVGElement> {
  return { clientX: x, clientY: y, pressure: 0.5, buttons: 1, button: 0, pointerId: 1,
    currentTarget: svg, preventDefault: vi.fn(), stopPropagation: vi.fn(), shiftKey } as unknown as PointerEvent<SVGSVGElement>;
}

function setup() {
  const wrapper = ({ children }: { children: ReactNode }) =>
    <BoardRuntimeContext.Provider value={runtime}>{children}</BoardRuntimeContext.Provider>;
  return renderHook(() => useCanvasGestures({
    svgRef: { current: svg }, cameraRef: { current: { x: 0, y: 0, scale: 1 } },
    updateCamera: vi.fn(), color: { r: 0, g: 0, b: 0 }, penSize: 16,
  }), { wrapper });
}

beforeEach(() => {
  stateListeners.clear();
  board = new BoardDocument();
  presence = emptyPresence();
  svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  let captured = false;
  Object.assign(svg, { setPointerCapture: vi.fn(() => { captured = true; }),
    releasePointerCapture: vi.fn(() => { captured = false; }), hasPointerCapture: () => captured,
    getBoundingClientRect: () => ({ left: 0, top: 0 }) });
  runtime = { board, getSelf: () => ({ presence }), subscribeState: (listener: () => void) => {
    stateListeners.add(listener); return () => stateListeners.delete(listener);
  }, updatePresence: (patch: Partial<BoardPresence>) => {
    presence = { ...presence, ...patch };
  } } as unknown as BoardRuntime;
  vi.stubGlobal("requestAnimationFrame", vi.fn(() => 1));
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
});
afterEach(() => { cleanup(); board.destroy(); vi.unstubAllGlobals(); });

describe("canvas gesture lifecycle", () => {
  it("draws the final Shift-constrained segment once and keeps the tool for a polygon", () => {
    const { result } = setup();
    const updates = vi.fn(); board.doc.on("update", updates);
    act(() => result.current.setCanvasState({ mode: BoardCanvasMode.Inserting, layerType: LayerType.Line, lineKind: "segment" }));
    act(() => result.current.onPointerDown(pointer(10, 20)));
    act(() => result.current.onPointerMove(pointer(60, 30)));
    expect(board.getSnapshot().layerIds).toEqual([]);
    act(() => result.current.onPointerUp(pointer(110, 25, true)));
    const [id] = board.getSnapshot().layerIds;
    const [start, end] = lineEndpoints(board.getLayer(id) as LineLayer);
    expect(start).toEqual({ x: 10, y: 20 });
    expect(end.x).toBeGreaterThan(110);
    expect(end.y).toBe(20);
    expect(updates).toHaveBeenCalledTimes(1);
    expect(result.current.canvasState).toMatchObject({ mode: BoardCanvasMode.Inserting, layerType: LayerType.Line, lineKind: "segment" });
    act(() => board.undo());
    expect(board.getSnapshot().layerIds).toEqual([]);
    act(() => board.redo());
    expect(board.getSnapshot().layerIds).toEqual([id]);
  });

  it("ignores line clicks and cancels a line draft without creating an object", () => {
    const { result } = setup();
    act(() => result.current.setCanvasState({ mode: BoardCanvasMode.Inserting, layerType: LayerType.Line, lineKind: "line" }));
    act(() => result.current.onPointerDown(pointer(30, 40)));
    act(() => result.current.onPointerUp(pointer(30, 40)));
    expect(board.getSnapshot().layerIds).toEqual([]);
    act(() => result.current.onPointerDown(pointer(30, 40)));
    act(() => result.current.onPointerMove(pointer(300, 400)));
    act(() => result.current.onPointerCancel());
    act(() => result.current.onPointerUp(pointer(300, 400)));
    expect(board.getSnapshot().layerIds).toEqual([]);
    expect(result.current.preview.line).toBeNull();
    expect(result.current.canvasState.mode).toBe(BoardCanvasMode.None);
  });

  it("moves an endpoint through its opposite end without swapping arrow identity or clamping dimensions", () => {
    const initial = { ...createLine({ x: 30, y: 40 }, { x: 130, y: 40 }, { r: 0, g: 0, b: 0 }), endArrow: true };
    const [id] = board.insert([initial]);
    const { result } = setup();
    const updates = vi.fn(); board.doc.on("update", updates);
    act(() => result.current.onLineEndpointPointerDown(id, "start", pointer(30, 40)));
    act(() => result.current.onPointerMove(pointer(160, 60)));
    expect(board.getLayer(id)).toEqual(initial);
    act(() => result.current.onPointerUp(pointer(200, 80)));
    const layer = board.getLayer(id) as LineLayer;
    expect(lineEndpoints(layer)).toEqual([{ x: 200, y: 80 }, { x: 130, y: 40 }]);
    expect(layer).toMatchObject({ width: 70, height: 40, startArrow: false, endArrow: true });
    expect(updates).toHaveBeenCalledTimes(1);
    act(() => board.undo());
    expect(board.getLayer(id)).toEqual(initial);
  });

  it("erases an infinite line beyond its anchors without erasing empty space inside a segment hitbox", () => {
    const [infinite, diagonal] = board.insert([
      createLine({ x: -1000, y: 200 }, { x: -900, y: 200 }, { r: 0, g: 0, b: 0 }, "line"),
      createLine({ x: 0, y: 0 }, { x: 100, y: 100 }, { r: 0, g: 0, b: 0 }),
    ]);
    const { result } = setup();
    act(() => result.current.setCanvasState({ mode: BoardCanvasMode.Eraser }));
    act(() => result.current.onPointerDown(pointer(300, 200)));
    act(() => result.current.onPointerUp(pointer(300, 200)));
    expect(board.getLayer(infinite)).toBeUndefined();
    act(() => result.current.onPointerDown(pointer(0, 100)));
    act(() => result.current.onPointerUp(pointer(0, 100)));
    expect(board.getLayer(diagonal)).toBeDefined();
  });

  it("selects a partially touched hitbox at pointer-up even before the queued frame runs", () => {
    const [id] = board.insert([createLayer(LayerType.Rectangle, { x: 100, y: 100 }, { r: 0, g: 0, b: 0 })]);
    const { result } = setup();
    const updates = vi.fn();
    board.doc.on("update", updates);
    act(() => result.current.onPointerDown(pointer(0, 0)));
    act(() => result.current.onPointerMove(pointer(90, 90)));
    expect(presence.selection).toEqual([]);
    act(() => result.current.onPointerUp(pointer(110, 110)));
    expect(presence.selection).toEqual([id]);
    expect(result.current.canvasState.mode).toBe(BoardCanvasMode.None);
    expect(board.getLayer(id)).toMatchObject({ x: 100, y: 100, width: 100, height: 100 });
    expect(updates).not.toHaveBeenCalled();
  });

  it("preserves text double-click targeting by waiting for movement before pointer capture", () => {
    const [id] = board.insert([createLayer(LayerType.Text, { x: 0, y: 0 }, { r: 0, g: 0, b: 0 })]);
    const { result } = setup();
    let updates = 0;
    board.doc.on("update", () => { updates += 1; });
    act(() => result.current.onLayerPointerDown(pointer(50, 50), id));
    act(() => result.current.onPointerUp(pointer(50, 50)));
    act(() => result.current.onLayerPointerDown(pointer(50, 50), id));
    act(() => result.current.onPointerUp(pointer(50, 50)));
    expect(svg.setPointerCapture).not.toHaveBeenCalled();
    expect(updates).toBe(0);
  });

  it("clears a pending uncaptured click when released outside the canvas", () => {
    const [id] = board.insert([createLayer(LayerType.Text, { x: 0, y: 0 }, { r: 0, g: 0, b: 0 })]);
    const { result } = setup();
    act(() => result.current.onLayerPointerDown(pointer(50, 50), id));
    act(() => window.dispatchEvent(new Event("pointerup")));
    // A native pointer event targets an element, not Window; reproduce that path too.
    act(() => document.body.dispatchEvent(new Event("pointerup", { bubbles: true })));
    expect(result.current.canvasState.mode).toBe(BoardCanvasMode.None);
    expect(board.getLayer(id)).toMatchObject({ x: 0, y: 0 });
  });

  it("clears an uncaptured click when the pointer leaves the canvas", () => {
    const [id] = board.insert([createLayer(LayerType.Text, { x: 0, y: 0 }, { r: 0, g: 0, b: 0 })]);
    const { result } = setup();
    act(() => result.current.onLayerPointerDown(pointer(50, 50), id));
    act(() => result.current.onPointerLeave());
    expect(result.current.canvasState.mode).toBe(BoardCanvasMode.None);
    expect(presence.cursor).toBeNull();
  });

  it("commits the pointer-up position even when a queued frame has not run", () => {
    const [id] = board.insert([createLayer(LayerType.Rectangle, { x: 10, y: 20 }, { r: 0, g: 0, b: 0 })]);
    const { result } = setup();
    let updates = 0;
    board.doc.on("update", () => { updates += 1; });
    act(() => result.current.onLayerPointerDown(pointer(10, 20), id));
    act(() => result.current.onPointerMove(pointer(40, 50)));
    expect(updates).toBe(0);
    act(() => result.current.onPointerUp(pointer(100, 200)));
    expect(board.getLayer(id)).toMatchObject({ x: 100, y: 200 });
    expect(updates).toBe(1);
    expect(svg.setPointerCapture).toHaveBeenCalledWith(1);
    expect(svg.releasePointerCapture).toHaveBeenCalledWith(1);
  });

  it("cancels a drag without writing partial coordinates or leaving a draft", () => {
    const [id] = board.insert([createLayer(LayerType.Rectangle, { x: 0, y: 0 }, { r: 0, g: 0, b: 0 })]);
    const { result } = setup();
    act(() => result.current.onLayerPointerDown(pointer(0, 0), id));
    act(() => result.current.onPointerMove(pointer(100, 100)));
    act(() => result.current.onPointerCancel());
    expect(board.getLayer(id)).toMatchObject({ x: 0, y: 0 });
    expect(result.current.canvasState.mode).toBe(BoardCanvasMode.None);
    expect(presence).toMatchObject({ drag: null, pencilDraft: null, eraserDraft: null });
  });

  it("includes the final pencil point and keeps the pencil tool after capture ends", () => {
    const { result } = setup();
    act(() => result.current.setCanvasState({ mode: BoardCanvasMode.Pencil }));
    act(() => result.current.onPointerDown(pointer(0, 0)));
    act(() => result.current.onPointerUp(pointer(40, 50)));
    act(() => result.current.onLostPointerCapture());
    const layer = [...board.getSnapshot().layers.values()][0];
    expect(layer).toMatchObject({ type: LayerType.Path, width: 40, height: 50 });
    expect(result.current.canvasState.mode).toBe(BoardCanvasMode.Pencil);
    expect(presence.pencilDraft).toBeNull();
  });

  it("immediately cancels an active drag on loss of writability and promotion cannot revive it", () => {
    const [id] = board.insert([createLayer(LayerType.Rectangle, { x: 0, y: 0 }, { r: 0, g: 0, b: 0 })]);
    const { result, unmount } = setup();
    const updates = vi.fn(); board.doc.on("update", updates);
    act(() => result.current.onLayerPointerDown(pointer(0, 0), id));
    act(() => result.current.onPointerMove(pointer(100, 100)));
    expect(svg.hasPointerCapture(1)).toBe(true);
    act(() => { board.setWritable(false); stateListeners.forEach((listener) => listener()); });
    expect(result.current.canvasState.mode).toBe(BoardCanvasMode.None);
    expect(result.current.preview.ids).toHaveLength(0);
    expect(svg.hasPointerCapture(1)).toBe(false);
    expect(presence).toMatchObject({ drag: null, pencilDraft: null, eraserDraft: null });
    act(() => { board.setWritable(true); stateListeners.forEach((listener) => listener()); });
    act(() => result.current.onPointerUp(pointer(100, 100)));
    expect(board.getLayer(id)).toMatchObject({ x: 0, y: 0 });
    expect(updates).not.toHaveBeenCalled();
    unmount();
    expect(stateListeners.size).toBe(0);
  });
});
