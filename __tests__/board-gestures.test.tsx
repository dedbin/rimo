import { ReactNode, PointerEvent } from "react";
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BoardDocument } from "@/lib/collaboration/document";
import { BoardRuntimeContext } from "@/lib/collaboration/react";
import type { BoardRuntime } from "@/lib/collaboration/runtime";
import { emptyPresence } from "@/lib/collaboration/presence";
import type { BoardPresence } from "@/lib/collaboration/presence";
import { createLayer } from "@/lib/board/model";
import { BoardCanvasMode, LayerType } from "@/types/board-canvas";
import { useCanvasGestures } from "@/app/board/[boardId]/_hooks/use-canvas-gestures";

let board: BoardDocument;
let presence: BoardPresence;
let svg: SVGSVGElement;
let runtime: BoardRuntime;
const stateListeners = new Set<() => void>();

function pointer(x: number, y: number): PointerEvent<SVGSVGElement> {
  return { clientX: x, clientY: y, pressure: 0.5, buttons: 1, button: 0, pointerId: 1,
    currentTarget: svg, preventDefault: vi.fn(), stopPropagation: vi.fn(), shiftKey: false } as unknown as PointerEvent<SVGSVGElement>;
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
