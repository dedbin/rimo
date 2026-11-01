import type { PointerEvent } from "react";
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { useGraphNavigation } from "@/components/board-graph/use-navigation";
import { boundedGraphViewport, panGraphViewport, zoomGraphViewport } from "@/lib/board/graph/navigation";
import { createGraphSettings, parseGraphViewport } from "@/lib/board/graph/model";
import { createLayer } from "@/lib/board/model";
import { BoardDocument } from "@/lib/collaboration/document";
import { LayerType } from "@/types/board-canvas";

const fixture = vi.hoisted(() => ({ board: null as unknown as BoardDocument }));
vi.mock("@/lib/collaboration/react", () => ({ useBoardRuntime: () => fixture }));
const boards: BoardDocument[] = [];
afterEach(() => { cleanup(); boards.splice(0).forEach((board) => board.destroy()); vi.unstubAllGlobals(); });

function setup() {
  const board = new BoardDocument(); boards.push(board); fixture.board = board;
  const [id] = board.insert([createLayer(LayerType.Graph, { x: 0, y: 0 }, { r: 0, g: 0, b: 0 })]);
  const element = document.createElement("div");
  const captures = new Set<number>();
  Object.assign(element, { getBoundingClientRect: () => ({ left: 0, top: 0, width: 640, height: 440 }),
    setPointerCapture: (pointerId: number) => captures.add(pointerId),
    hasPointerCapture: (pointerId: number) => captures.has(pointerId),
    releasePointerCapture: (pointerId: number) => captures.delete(pointerId) });
  vi.stubGlobal("requestAnimationFrame", vi.fn(() => 1));
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
  const hook = renderHook(({ enabled }) => {
    const navigation = useGraphNavigation(id, createGraphSettings().viewport, enabled);
    navigation.ref.current = element;
    return navigation;
  }, { initialProps: { enabled: true } });
  const pointer = (x: number, buttons = 1): PointerEvent<HTMLDivElement> => ({
    pointerId: 1, pointerType: "mouse", button: 0, buttons, clientX: x, clientY: 200,
    preventDefault: vi.fn(), stopPropagation: vi.fn(), currentTarget: element,
  }) as unknown as PointerEvent<HTMLDivElement>;
  const viewport = () => {
    const layer = board.getLayer(id);
    if (layer?.type !== LayerType.Graph) throw new Error("Missing graph fixture");
    return layer.graph.viewport;
  };
  return { board, id, element, captures, hook, pointer, viewport };
}

describe("graph coordinate navigation", () => {
  it("zooms around the cursor without mutating the viewport and clamps extremes", () => {
    const original = createGraphSettings().viewport;
    const copy = { ...original };
    const zoomed = zoomGraphViewport(original, 0.5, 0.25, 0.75);
    expect(zoomed.xMin + (zoomed.xMax - zoomed.xMin) * 0.25).toBeCloseTo(-4);
    expect(zoomed.yMax - (zoomed.yMax - zoomed.yMin) * 0.75).toBeCloseTo(-2.75);
    expect(original).toEqual(copy);
    expect(parseGraphViewport(boundedGraphViewport({ xMin: -1e20, xMax: 1e20, yMin: -1e20, yMax: 1e20 }))).not.toBeNull();
    expect(parseGraphViewport(panGraphViewport(original, 1e20, -1e20))).not.toBeNull();
  });

  it("keeps drag previews local and commits one undoable viewport on release", () => {
    const { board, hook, pointer, viewport } = setup();
    act(() => { hook.result.current.pointerDown(pointer(200)); hook.result.current.pointerMove(pointer(264)); });
    expect(viewport().xMin).toBe(-8);
    act(() => hook.result.current.finish(pointer(264, 0)));
    expect(viewport().xMin).toBeCloseTo(-9.6);
    act(() => board.undoManager.undo());
    expect(viewport()).toEqual(createGraphSettings().viewport);
  });

  it.each(["cancel", "blur", "lost-capture", "released-button"])("cancels %s without saving or resuming an abandoned drag", (reason) => {
    const { hook, pointer, viewport, captures } = setup();
    act(() => { hook.result.current.pointerDown(pointer(200)); hook.result.current.pointerMove(pointer(264)); });
    act(() => {
      if (reason === "cancel") hook.result.current.cancel();
      if (reason === "blur") window.dispatchEvent(new Event("blur"));
      if (reason === "lost-capture") hook.result.current.lostCapture(pointer(264));
      if (reason === "released-button") hook.result.current.pointerMove(pointer(264, 0));
    });
    act(() => { hook.result.current.pointerMove(pointer(400)); hook.result.current.finish(pointer(400, 0)); });
    expect(viewport()).toEqual(createGraphSettings().viewport);
    expect(captures.size).toBe(0);
  });

  it("finishes a pending wheel view when leaving navigation, preserving the last visible region", () => {
    const { hook, element, viewport } = setup();
    act(() => element.dispatchEvent(new WheelEvent("wheel", { deltaY: -100, clientX: 320, clientY: 220, cancelable: true })));
    expect(viewport().xMax - viewport().xMin).toBe(16);
    act(() => hook.rerender({ enabled: false }));
    expect(viewport().xMax - viewport().xMin).toBeLessThan(16);
  });
});
