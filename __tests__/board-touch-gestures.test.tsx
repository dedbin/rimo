import type { PointerEvent, ReactNode } from "react";
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useCanvasGestures } from "@/app/board/[boardId]/_hooks/use-canvas-gestures";
import { createLayer } from "@/lib/board/model";
import { createLine } from "@/lib/board/line";
import { BoardDocument } from "@/lib/collaboration/document";
import { emptyPresence, type BoardPresence } from "@/lib/collaboration/presence";
import { BoardRuntimeContext } from "@/lib/collaboration/react";
import type { BoardRuntime } from "@/lib/collaboration/runtime";
import { BoardCanvasMode, LayerType, side, type Camera, type Color } from "@/types/board-canvas";

let board: BoardDocument;
let runtime: BoardRuntime;
let presence: BoardPresence;
let svg: SVGSVGElement;
let cameraRef: { current: Camera };
let frames: Map<number, FrameRequestCallback>;
let sequence: number;
const black = { r: 0, g: 0, b: 0 };
const blue = { r: 59, g: 130, b: 246 };

function pointer(id: number, x: number, y: number, pointerType = "touch"): PointerEvent<SVGSVGElement> {
  return { pointerId: id, pointerType, clientX: x, clientY: y, pressure: 0.5, buttons: 1, button: 0,
    currentTarget: svg, preventDefault: vi.fn(), stopPropagation: vi.fn() } as unknown as PointerEvent<SVGSVGElement>;
}

function setup() {
  const svgRef = { current: svg };
  const wrapper = ({ children }: { children: ReactNode }) =>
    <BoardRuntimeContext.Provider value={runtime}>{children}</BoardRuntimeContext.Provider>;
  return renderHook(({ penColor, penSize }: { penColor: Color; penSize: number }) => useCanvasGestures({
    svgRef, cameraRef, updateCamera: (next) => { cameraRef.current = next; }, color: black, penColor, penSize,
  }), { wrapper, initialProps: { penColor: blue, penSize: 24 } });
}

beforeEach(() => {
  board = new BoardDocument();
  presence = emptyPresence();
  cameraRef = { current: { x: 0, y: 0, scale: 1 } };
  svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  const captured = new Set<number>();
  Object.assign(svg, { setPointerCapture: vi.fn((id: number) => captured.add(id)),
    releasePointerCapture: vi.fn((id: number) => captured.delete(id)), hasPointerCapture: (id: number) => captured.has(id),
    getBoundingClientRect: () => ({ left: 0, top: 0 }) });
  runtime = { board, getSelf: () => ({ presence }), subscribeState: () => () => {},
    updatePresence: (patch: Partial<BoardPresence>) => { presence = { ...presence, ...patch }; } } as unknown as BoardRuntime;
  sequence = 0;
  frames = new Map();
  vi.stubGlobal("requestAnimationFrame", vi.fn((callback: FrameRequestCallback) => { frames.set(++sequence, callback); return sequence; }));
  vi.stubGlobal("cancelAnimationFrame", vi.fn((id: number) => frames.delete(id)));
});

afterEach(() => { cleanup(); board.destroy(); vi.unstubAllGlobals(); });

describe("touch navigation and editing arbitration", () => {
  it("zooms around the midpoint relative to the SVG and discards the first finger's pencil draft", () => {
    cameraRef.current = { x: 10, y: 20, scale: 1 };
    svg.getBoundingClientRect = () => ({ left: 20, top: 30 }) as DOMRect;
    const { result } = setup();
    const updates = vi.fn(); board.doc.on("update", updates);
    act(() => result.current.setCanvasState({ mode: BoardCanvasMode.Pencil }));
    act(() => { result.current.onPointerDownCapture(pointer(1, 120, 130)); result.current.onPointerDown(pointer(1, 120, 130)); });
    expect(presence.pencilDraft).not.toBeNull();
    const second = pointer(2, 220, 130);
    act(() => result.current.onPointerDownCapture(second));
    expect(second.stopPropagation).toHaveBeenCalled();
    expect(presence.pencilDraft).toBeNull();
    act(() => { result.current.onPointerMove(pointer(1, 70, 130)); result.current.onPointerMove(pointer(2, 270, 130)); });
    expect(cameraRef.current).toEqual({ x: -130, y: -60, scale: 2 });
    act(() => { result.current.onPointerUp(pointer(1, 70, 130)); result.current.onPointerUp(pointer(2, 270, 130)); });
    expect(result.current.canvasState.mode).toBe(BoardCanvasMode.Pencil);
    expect(board.getSnapshot().layerIds).toEqual([]);
    expect(updates).not.toHaveBeenCalled();
  });

  it("does not resume drawing with the remaining finger, but a fresh touch draws normally", () => {
    const { result } = setup();
    act(() => result.current.setCanvasState({ mode: BoardCanvasMode.Pencil }));
    act(() => { result.current.onPointerDownCapture(pointer(1, 100, 100)); result.current.onPointerDown(pointer(1, 100, 100)); });
    act(() => result.current.onPointerDownCapture(pointer(2, 200, 100)));
    act(() => result.current.onPointerUp(pointer(2, 200, 100)));
    act(() => { result.current.onPointerMove(pointer(1, 500, 500)); result.current.onPointerUp(pointer(1, 500, 500)); });
    expect(board.getSnapshot().layerIds).toHaveLength(0);
    act(() => { result.current.onPointerDownCapture(pointer(3, 300, 200)); result.current.onPointerDown(pointer(3, 300, 200)); });
    act(() => result.current.onPointerUp(pointer(3, 340, 250)));
    expect(board.getSnapshot().layerIds).toHaveLength(1);
  });

  it.each(["translate", "resize", "endpoint", "eraser", "shape"])("cancels %s before a second finger can edit a layer", (kind) => {
    const initial = kind === "endpoint" ? createLine({ x: 100, y: 100 }, { x: 200, y: 100 }, black)
      : createLayer(LayerType.Rectangle, { x: 100, y: 100 }, black);
    const [id] = board.insert([initial]);
    const { result } = setup();
    const updates = vi.fn(); board.doc.on("update", updates);
    act(() => result.current.onPointerDownCapture(pointer(1, 100, 100)));
    act(() => {
      if (kind === "translate") result.current.onLayerPointerDown(pointer(1, 100, 100), id);
      else if (kind === "resize") result.current.onResizeHandlePointerDown(side.right | side.bottom, initial, pointer(1, 100, 100));
      else if (kind === "endpoint") result.current.onLineEndpointPointerDown(id, "start", pointer(1, 100, 100));
      else {
        result.current.setCanvasState(kind === "eraser" ? { mode: BoardCanvasMode.Eraser }
          : { mode: BoardCanvasMode.Inserting, layerType: LayerType.Rectangle });
        result.current.onPointerDown(pointer(1, 100, 100));
      }
      result.current.onPointerMove(pointer(1, 120, 120));
    });
    act(() => { for (const callback of frames.values()) callback(10); frames.clear(); });
    act(() => result.current.onPointerDownCapture(pointer(2, 250, 250)));
    // Defend the child entry points too, even if they are invoked directly.
    act(() => {
      result.current.onLayerPointerDown(pointer(2, 250, 250), id);
      result.current.onResizeHandlePointerDown(side.right, initial, pointer(2, 250, 250));
      result.current.onLineEndpointPointerDown(id, "start", pointer(2, 250, 250));
      result.current.onPointerDown(pointer(2, 250, 250));
    });
    act(() => { result.current.onPointerUp(pointer(1, 120, 120)); result.current.onPointerUp(pointer(2, 250, 250)); });
    expect(board.getSnapshot().layerIds).toEqual([id]);
    expect(board.getLayer(id)).toEqual(initial);
    expect(result.current.preview.ids).toEqual([]);
    expect(result.current.preview.line).toBeNull();
    expect(updates).not.toHaveBeenCalled();
    expect(presence).toMatchObject({ pencilDraft: null, eraserDraft: null, drag: null });
  });

  it("pans for a viewer without creating edits or undo entries", () => {
    board.setWritable(false);
    const { result } = setup();
    const updates = vi.fn(); board.doc.on("update", updates);
    act(() => { result.current.onPointerDownCapture(pointer(1, 100, 100)); result.current.onPointerDown(pointer(1, 100, 100)); });
    act(() => result.current.onPointerDownCapture(pointer(2, 200, 100)));
    act(() => { result.current.onPointerMove(pointer(1, 130, 120)); result.current.onPointerMove(pointer(2, 230, 120)); });
    expect(cameraRef.current).toEqual({ x: 30, y: 20, scale: 1 });
    expect(updates).not.toHaveBeenCalled();
    expect(board.undoManager.undoStack).toHaveLength(0);
  });

  it("ignores a third contact in pinch math and rebases without a jump when a paired contact ends", () => {
    const { result } = setup();
    act(() => result.current.onPointerDownCapture(pointer(1, 100, 100)));
    act(() => result.current.onPointerDownCapture(pointer(2, 200, 100)));
    act(() => result.current.onPointerDownCapture(pointer(3, 400, 400)));
    act(() => result.current.onPointerMove(pointer(3, 600, 600)));
    expect(cameraRef.current).toEqual({ x: 0, y: 0, scale: 1 });
    act(() => result.current.onPointerUp(pointer(1, 100, 100)));
    act(() => result.current.onPointerMove(pointer(2, 200, 100)));
    expect(cameraRef.current).toEqual({ x: 0, y: 0, scale: 1 });
    act(() => { result.current.onPointerMove(pointer(2, 210, 110)); result.current.onPointerMove(pointer(3, 610, 610)); });
    expect(cameraRef.current).toEqual({ x: 10, y: 10, scale: 1 });
  });

  it("clamps pinch scale to the supported range", () => {
    const { result } = setup();
    act(() => result.current.onPointerDownCapture(pointer(1, 100, 100)));
    act(() => result.current.onPointerDownCapture(pointer(2, 200, 100)));
    act(() => result.current.onPointerMove(pointer(2, 10000, 100)));
    expect(cameraRef.current.scale).toBe(4);
    act(() => result.current.onPointerMove(pointer(2, 100, 100)));
    expect(cameraRef.current.scale).toBe(0.1);
  });

  it.each(["cancel", "capture"])("stops navigation on pointer %s and suppresses the remaining fingers", (kind) => {
    const { result } = setup();
    act(() => result.current.setCanvasState({ mode: BoardCanvasMode.Pencil }));
    act(() => { result.current.onPointerDownCapture(pointer(1, 100, 100)); result.current.onPointerDown(pointer(1, 100, 100)); });
    act(() => result.current.onPointerDownCapture(pointer(2, 200, 100)));
    act(() => {
      if (kind === "cancel") result.current.onPointerCancel(pointer(2, 200, 100));
      else { svg.releasePointerCapture(2); result.current.onLostPointerCapture(pointer(2, 200, 100)); }
    });
    const previous = { ...cameraRef.current };
    act(() => { result.current.onPointerMove(pointer(1, 700, 700)); result.current.onPointerMove(pointer(2, 900, 900)); });
    expect(cameraRef.current).toEqual(previous);
    act(() => { result.current.onPointerUp(pointer(1, 700, 700)); result.current.onPointerUp(pointer(2, 900, 900)); });
    expect(board.getSnapshot().layerIds).toHaveLength(0);
  });

  it("resets tracking on blur so a new gesture works", () => {
    const { result } = setup();
    act(() => result.current.onPointerDownCapture(pointer(1, 100, 100)));
    act(() => result.current.onPointerDownCapture(pointer(2, 200, 100)));
    act(() => window.dispatchEvent(new Event("blur")));
    act(() => result.current.setCanvasState({ mode: BoardCanvasMode.Pencil }));
    act(() => { result.current.onPointerDownCapture(pointer(3, 100, 100)); result.current.onPointerDown(pointer(3, 100, 100)); });
    act(() => result.current.onPointerUp(pointer(3, 150, 150)));
    expect(board.getSnapshot().layerIds).toHaveLength(1);
  });

  it("does not let a foreign pointer move, release or cancel the active pen", () => {
    const { result } = setup();
    act(() => result.current.setCanvasState({ mode: BoardCanvasMode.Pencil }));
    act(() => { result.current.onPointerDownCapture(pointer(1, 100, 100, "pen")); result.current.onPointerDown(pointer(1, 100, 100, "pen")); });
    act(() => {
      result.current.onPointerMove(pointer(2, 800, 800, "mouse"));
      result.current.onPointerUp(pointer(2, 800, 800, "mouse"));
      result.current.onPointerCancel(pointer(2, 800, 800, "mouse"));
      result.current.onLostPointerCapture(pointer(2, 800, 800, "mouse"));
      result.current.onPointerLeave(pointer(2, 800, 800, "mouse"));
    });
    act(() => result.current.onPointerUp(pointer(1, 120, 130, "pen")));
    expect([...board.getSnapshot().layers.values()][0]).toMatchObject({ width: 20, height: 30 });
  });

  it("keeps an uncaptured layer drag when another pointer leaves the canvas", () => {
    const [id] = board.insert([createLayer(LayerType.Rectangle, { x: 100, y: 100 }, black)]);
    const { result } = setup();
    act(() => result.current.onLayerPointerDown(pointer(1, 120, 120, "pen"), id));
    expect(svg.hasPointerCapture(1)).toBe(false);
    act(() => result.current.onPointerLeave(pointer(2, 800, 800, "mouse")));
    expect(result.current.canvasState.mode).toBe(BoardCanvasMode.Translating);
    act(() => result.current.onPointerUp(pointer(1, 150, 160, "pen")));
    expect(board.getLayer(id)).toMatchObject({ x: 130, y: 140 });
  });

  it("ignores palm contacts while drawing with a stylus", () => {
    const { result } = setup();
    act(() => result.current.setCanvasState({ mode: BoardCanvasMode.Pencil }));
    act(() => { result.current.onPointerDownCapture(pointer(1, 100, 100, "pen")); result.current.onPointerDown(pointer(1, 100, 100, "pen")); });
    act(() => { result.current.onPointerDownCapture(pointer(2, 500, 500)); result.current.onPointerDownCapture(pointer(3, 600, 600)); });
    act(() => { result.current.onPointerMove(pointer(2, 800, 800)); result.current.onPointerCancel(pointer(2, 800, 800)); });
    act(() => result.current.onPointerUp(pointer(1, 120, 130, "pen")));
    expect([...board.getSnapshot().layers.values()][0]).toMatchObject({ width: 20, height: 30, fill: blue });
    expect(cameraRef.current).toEqual({ x: 0, y: 0, scale: 1 });
  });

  it("keeps navigation when a child transfers its implicit touch capture to the SVG", () => {
    const { result } = setup();
    act(() => result.current.onPointerDownCapture(pointer(1, 100, 100)));
    act(() => result.current.onPointerDownCapture(pointer(2, 200, 100)));
    act(() => result.current.onLostPointerCapture(pointer(1, 100, 100)));
    act(() => { result.current.onPointerMove(pointer(1, 130, 120)); result.current.onPointerMove(pointer(2, 230, 120)); });
    expect(cameraRef.current).toEqual({ x: 30, y: 20, scale: 1 });
  });

  it("lets a stylus replace an uncommitted touch draft and forgets it on explicit cancel", () => {
    const { result } = setup();
    act(() => result.current.setCanvasState({ mode: BoardCanvasMode.Pencil }));
    act(() => { result.current.onPointerDownCapture(pointer(1, 100, 100)); result.current.onPointerDown(pointer(1, 100, 100)); });
    act(() => { result.current.onPointerDownCapture(pointer(2, 200, 200, "pen")); result.current.onPointerDown(pointer(2, 200, 200, "pen")); });
    act(() => result.current.onPointerUp(pointer(2, 250, 250, "pen")));
    act(() => result.current.onPointerUp(pointer(1, 100, 100)));
    expect([...board.getSnapshot().layers.values()]).toMatchObject([{ x: 200, y: 200, width: 50, height: 50 }]);
    act(() => { result.current.onPointerDownCapture(pointer(3, 300, 300, "pen")); result.current.onPointerDown(pointer(3, 300, 300, "pen")); });
    act(() => result.current.cancel());
    act(() => result.current.setCanvasState({ mode: BoardCanvasMode.Pencil }));
    act(() => { result.current.onPointerDownCapture(pointer(4, 400, 400)); result.current.onPointerDown(pointer(4, 400, 400)); });
    act(() => result.current.onPointerUp(pointer(4, 450, 450)));
    expect(board.getSnapshot().layerIds).toHaveLength(2);
  });

  it("uses the pencil color and width captured at pointerdown after preferences change", () => {
    const { result, rerender } = setup();
    act(() => result.current.setCanvasState({ mode: BoardCanvasMode.Pencil }));
    act(() => result.current.onPointerDown(pointer(1, 100, 100, "mouse")));
    rerender({ penColor: { r: 255, g: 0, b: 0 }, penSize: 4 });
    expect(result.current.pencilStyle).toEqual({ color: blue, size: 24 });
    expect(presence).toMatchObject({ penColor: blue, penSize: 24 });
    act(() => result.current.onPointerUp(pointer(1, 140, 150, "mouse")));
    expect([...board.getSnapshot().layers.values()][0]).toMatchObject({ fill: blue, size: 24 });
    act(() => result.current.setCanvasState({ mode: BoardCanvasMode.Inserting, layerType: LayerType.Rectangle }));
    act(() => result.current.onPointerDown(pointer(1, 500, 500, "mouse")));
    act(() => result.current.onPointerUp(pointer(1, 500, 500, "mouse")));
    expect([...board.getSnapshot().layers.values()][1]).toMatchObject({ fill: black });
  });
});
