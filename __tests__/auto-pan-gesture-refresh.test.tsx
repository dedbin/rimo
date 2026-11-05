import type { PointerEvent, ReactNode } from "react";
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useCanvasGestures } from "@/app/board/[boardId]/_hooks/use-canvas-gestures";
import { createLayer } from "@/lib/board/model";
import { lineEndpoints } from "@/lib/board/line";
import { BoardDocument } from "@/lib/collaboration/document";
import { emptyPresence, type BoardPresence } from "@/lib/collaboration/presence";
import { BoardRuntimeContext } from "@/lib/collaboration/react";
import type { BoardRuntime } from "@/lib/collaboration/runtime";
import { BoardCanvasMode, LayerType, side, type Camera, type LineLayer } from "@/types/board-canvas";

let board: BoardDocument;
let runtime: BoardRuntime;
let presence: BoardPresence;
let svg: SVGSVGElement;
let cameraRef: { current: Camera };

function pointer(x: number, y: number): PointerEvent<SVGSVGElement> {
  return { pointerId: 1, pointerType: "mouse", clientX: x, clientY: y, pressure: 0.5, buttons: 1, button: 0,
    currentTarget: svg, preventDefault: vi.fn(), stopPropagation: vi.fn() } as unknown as PointerEvent<SVGSVGElement>;
}

function setup() {
  const wrapper = ({ children }: { children: ReactNode }) =>
    <BoardRuntimeContext.Provider value={runtime}>{children}</BoardRuntimeContext.Provider>;
  return renderHook(() => useCanvasGestures({ svgRef: { current: svg }, cameraRef,
    updateCamera: (next) => { cameraRef.current = next; }, color: { r: 0, g: 0, b: 0 }, penSize: 16 }), { wrapper });
}

beforeEach(() => {
  board = new BoardDocument();
  presence = emptyPresence();
  cameraRef = { current: { x: 0, y: 0, scale: 1 } };
  svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  const captured = new Set<number>();
  Object.assign(svg, { getBoundingClientRect: () => ({ left: 0, top: 0 }),
    setPointerCapture: (id: number) => captured.add(id), releasePointerCapture: (id: number) => captured.delete(id),
    hasPointerCapture: (id: number) => captured.has(id) });
  runtime = { board, getSelf: () => ({ presence }), subscribeState: () => () => undefined,
    updatePresence: (patch: Partial<BoardPresence>) => { presence = { ...presence, ...patch }; } } as unknown as BoardRuntime;
  vi.stubGlobal("requestAnimationFrame", vi.fn(() => 1));
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
});

afterEach(() => { cleanup(); board.destroy(); vi.unstubAllGlobals(); });

describe("stationary cursor while the board camera moves", () => {
  it("captures a fast translation on window exit before React can cancel it on leave", () => {
    const [id] = board.insert([createLayer(LayerType.Rectangle, { x: 100, y: 100 }, { r: 0, g: 0, b: 0 })]);
    board.undoManager.stopCapturing();
    const { result } = setup();
    act(() => result.current.onLayerPointerDown(pointer(120, 120), id));
    expect(svg.hasPointerCapture(1)).toBe(false);
    act(() => result.current.refreshPointer(pointer(1200, 120)));
    act(() => result.current.onPointerLeave(pointer(1200, 120)));
    expect(svg.hasPointerCapture(1)).toBe(true);
    expect(result.current.canvasState.mode).toBe(BoardCanvasMode.Translating);
    cameraRef.current = { x: -50, y: 0, scale: 1 };
    act(() => result.current.refreshPointer(pointer(1200, 120)));
    act(() => result.current.onPointerUp(pointer(1200, 120)));
    expect(board.getLayer(id)).toMatchObject({ x: 1230, y: 100 });
    act(() => board.undo());
    expect(board.getLayer(id)).toMatchObject({ x: 100, y: 100 });
  });

  it("waits for real drag movement before allowing clicks to auto-pan", () => {
    const [id] = board.insert([createLayer(LayerType.Rectangle, { x: 100, y: 100 }, { r: 0, g: 0, b: 0 })]);
    const { result } = setup();
    act(() => result.current.onLayerPointerDown(pointer(120, 120), id));
    expect(result.current.canAutoPan(pointer(120, 120))).toBe(false);
    expect(result.current.canAutoPan(pointer(121, 120))).toBe(false);
    expect(result.current.canAutoPan(pointer(124, 120))).toBe(true);
    act(() => result.current.onPointerMove(pointer(124, 120)));
    expect(result.current.canAutoPan(pointer(120, 120))).toBe(true);
    act(() => result.current.cancel());
    act(() => result.current.onPointerDown(pointer(900, 500)));
    expect(result.current.canAutoPan(pointer(900, 500))).toBe(false);
    expect(result.current.canAutoPan(pointer(908, 500))).toBe(true);
  });

  it("updates a viewer cursor without changing the document or undo history", () => {
    board.setWritable(false);
    const updates = vi.fn(); board.doc.on("update", updates);
    const { result } = setup();
    cameraRef.current = { x: -40, y: -10, scale: 2 };
    act(() => result.current.refreshPointer({ ...pointer(100, 50), buttons: 0 }));
    expect(presence.cursor).toEqual({ x: 70, y: 30 });
    expect(updates).not.toHaveBeenCalled();
    expect(board.undoManager.undoStack).toHaveLength(0);
  });

  it("keeps a dragged object under the cursor and commits one undoable move", () => {
    const [id] = board.insert([createLayer(LayerType.Rectangle, { x: 100, y: 100 }, { r: 0, g: 0, b: 0 })]);
    board.undoManager.stopCapturing();
    const { result } = setup();
    act(() => result.current.onLayerPointerDown(pointer(120, 120), id));
    act(() => result.current.onPointerMove(pointer(130, 120)));
    cameraRef.current = { x: -50, y: 0, scale: 1 };
    act(() => result.current.refreshPointer(pointer(130, 120)));
    expect(result.current.preview.delta).toEqual({ x: 60, y: 0 });
    expect(board.getLayer(id)).toMatchObject({ x: 100 });
    act(() => result.current.onPointerUp(pointer(130, 120)));
    expect(board.getLayer(id)).toMatchObject({ x: 160 });
    act(() => board.undo());
    expect(board.getLayer(id)).toMatchObject({ x: 100 });
  });

  it("extends a marker stroke beneath a stationary cursor and undoes it once", () => {
    const { result } = setup();
    act(() => result.current.setCanvasState({ mode: BoardCanvasMode.Pencil }));
    act(() => result.current.onPointerDown(pointer(900, 300)));
    cameraRef.current = { x: -50, y: 0, scale: 1 };
    act(() => result.current.refreshPointer(pointer(900, 300)));
    expect(presence.pencilDraft?.at(-1)?.slice(0, 2)).toEqual([950, 300]);
    expect(board.getSnapshot().layerIds).toHaveLength(0);
    act(() => result.current.onPointerUp(pointer(900, 300)));
    expect(board.getSnapshot().layerIds).toHaveLength(1);
    act(() => board.undo());
    expect(board.getSnapshot().layerIds).toHaveLength(0);
  });

  it("refreshes resize bounds before a single document commit", () => {
    const shape = { ...createLayer(LayerType.Rectangle, { x: 100, y: 100 }, { r: 0, g: 0, b: 0 }), width: 100, height: 100 };
    const [id] = board.insert([shape]);
    presence.selection = [id];
    board.undoManager.stopCapturing();
    const { result } = setup();
    act(() => result.current.onResizeHandlePointerDown(side.bottom | side.right, shape, pointer(200, 200)));
    cameraRef.current = { x: -50, y: -20, scale: 1 };
    act(() => result.current.refreshPointer(pointer(200, 200)));
    expect(result.current.preview.resize).toMatchObject({ x: 100, y: 100, width: 150, height: 120 });
    expect(board.getLayer(id)).toMatchObject({ width: 100 });
    act(() => result.current.onPointerUp(pointer(200, 200)));
    expect(board.getLayer(id)).toMatchObject({ width: 150, height: 120 });
    act(() => board.undo());
    expect(board.getLayer(id)).toMatchObject({ width: 100, height: 100 });
  });

  it("expands the selection net over newly revealed objects", () => {
    const [id] = board.insert([createLayer(LayerType.Rectangle, { x: 270, y: 100 }, { r: 0, g: 0, b: 0 })]);
    const { result } = setup();
    act(() => result.current.onPointerDown(pointer(100, 50)));
    act(() => result.current.refreshPointer(pointer(200, 250)));
    expect(presence.selection).toEqual([]);
    cameraRef.current = { x: -300, y: 0, scale: 1 };
    act(() => result.current.refreshPointer(pointer(200, 250)));
    expect(result.current.canvasState).toMatchObject({ mode: BoardCanvasMode.SelectionNet, current: { x: 500, y: 250 } });
    expect(presence.selection).toEqual([id]);
  });

  it("refreshes a draft line endpoint and ignores a foreign pointer", () => {
    const { result } = setup();
    act(() => result.current.setCanvasState({ mode: BoardCanvasMode.Inserting, layerType: LayerType.Line, lineKind: "segment" }));
    act(() => result.current.onPointerDown(pointer(100, 100)));
    cameraRef.current = { x: -50, y: 0, scale: 1 };
    act(() => result.current.refreshPointer({ ...pointer(200, 100), pointerId: 2 }));
    expect(result.current.preview.line).toBeNull();
    act(() => result.current.refreshPointer(pointer(200, 100)));
    expect(lineEndpoints(result.current.preview.line!)).toEqual([{ x: 100, y: 100 }, { x: 250, y: 100 }]);
    expect(board.getSnapshot().layerIds).toHaveLength(0);
    act(() => result.current.onPointerUp(pointer(200, 100)));
    const layer = [...board.getSnapshot().layers.values()][0] as LineLayer;
    expect(lineEndpoints(layer)).toEqual([{ x: 100, y: 100 }, { x: 250, y: 100 }]);
    act(() => board.undo());
    expect(board.getSnapshot().layerIds).toHaveLength(0);
  });
});
