import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";

import { Ellipse } from "@/app/board/[boardId]/_components/ellipse";
import { Rectangle } from "@/app/board/[boardId]/_components/rectangle";
import { ShapeColorControls } from "@/app/board/[boardId]/_components/shape-color-controls";
import { rgbToCss } from "@/lib/board/colors";
import { createLayer, parseLayer } from "@/lib/board/model";
import { isShape } from "@/lib/board/shape-style";
import type { Paint, ShapeLayer } from "@/lib/board/shape-style";
import { BoardDocument } from "@/lib/collaboration/document";
import { emptyPresence } from "@/lib/collaboration/presence";
import { BoardRuntimeContext } from "@/lib/collaboration/react";
import type { BoardRuntime } from "@/lib/collaboration/runtime";
import { LayerType } from "@/types/board-canvas";
import type { Color, Layer } from "@/types/board-canvas";

interface PickerProps {
  label: string;
  value: Paint;
  mixed: boolean;
  onChange: (color: Paint) => void;
  emptyLabel?: string;
}

vi.mock("@/hooks/use-translation", () => ({
  useTranslation: () => ({ t: (key: string) => {
    const labels: Record<string, string> = {
      "selectionTools.outline": "Контур", "selectionTools.fill": "Заливка", "selectionTools.noFill": "Без заливки",
    };
    return labels[key] ?? key;
  } }),
}));
vi.mock("@/app/board/[boardId]/_components/paint-picker", () => ({
  PaintPicker: ({ label, value, mixed, onChange, emptyLabel }: PickerProps) => <section aria-label={label}>
    <output data-testid={`${label}-value`}>{JSON.stringify({ value, mixed })}</output>
    <button onClick={() => onChange({ r: 59, g: 130, b: 246 })}>{label}: синий</button>
    <button onClick={() => onChange({ r: 239, g: 68, b: 68 })}>{label}: красный</button>
    {emptyLabel && <button onClick={() => onChange(null)}>{emptyLabel}</button>}
  </section>,
}));

const BLUE: Color = { r: 59, g: 130, b: 246 };
const RED: Color = { r: 239, g: 68, b: 68 };
const boards = new Set<BoardDocument>();

function board(): BoardDocument {
  const result = new BoardDocument();
  boards.add(result);
  return result;
}

function legacy(type: LayerType.Rectangle | LayerType.Ellipse, color: Color): ShapeLayer {
  return { type, x: 20, y: 30, width: 100, height: 80, fill: color };
}

function shape(document: BoardDocument, id: string): ShapeLayer {
  const result = document.getLayer(id);
  if (!isShape(result)) throw new Error("Expected a shape fixture");
  return result;
}

function controls(document: BoardDocument, selection: string[]) {
  const presence = { ...emptyPresence(), selection };
  const runtime = { board: document, getSelf: () => ({ presence }), subscribePresence: () => () => {} } as unknown as BoardRuntime;
  const lastUsedColor = vi.fn();
  render(<BoardRuntimeContext.Provider value={runtime}>
    <ShapeColorControls setLastUsedColor={lastUsedColor} />
  </BoardRuntimeContext.Provider>);
  return lastUsedColor;
}

function picker(label: "Контур" | "Заливка"): { value: Paint; mixed: boolean } {
  return JSON.parse(screen.getByTestId(`${label}-value`).textContent!);
}

afterEach(() => {
  cleanup();
  for (const document of boards) document.destroy();
  boards.clear();
});

describe("shape appearance", () => {
  it.each([LayerType.Rectangle, LayerType.Ellipse])("creates a visible outline with a transparent interior for type %s", (type) => {
    const input = { ...BLUE, a: 0.5 };
    const created = createLayer(type, { x: 20, y: 30 }, input);
    if (!isShape(created)) throw new Error("Expected a shape fixture");
    expect(input.a).toBe(0.5);
    expect(parseLayer(created)).toEqual(created);
    const view = render(<svg>{created.type === LayerType.Rectangle
      ? <Rectangle id="shape" layer={created} onPointerDown={vi.fn()} />
      : <Ellipse id="shape" layer={created} onPointerDown={vi.fn()} />}</svg>);
    const element = view.container.querySelector(type === LayerType.Rectangle ? "rect" : "ellipse")!;
    expect(element.getAttribute("fill")).toBe("rgba(59,130,246,0)");
    expect(element.getAttribute("stroke")).toBe("rgba(59,130,246,1)");
    expect(element.getAttribute("stroke-width")).toBe("2");
    expect(element.getAttribute("pointer-events")).toBe("all");
  });

  it("preserves filled legacy shapes and text/sticker defaults", () => {
    const filled = legacy(LayerType.Rectangle, BLUE);
    if (filled.type !== LayerType.Rectangle) throw new Error("Expected a rectangle fixture");
    const view = render(<svg><Rectangle id="legacy" layer={filled} onPointerDown={vi.fn()} /></svg>);
    const element = view.container.querySelector("rect")!;
    expect(element.getAttribute("fill")).toBe(rgbToCss(BLUE));
    expect(element.getAttribute("stroke")).toBe("transparent");
    expect(element.getAttribute("stroke-width")).toBe("0");
    for (const type of [LayerType.Text, LayerType.Sticker]) {
      expect(createLayer(type, { x: 0, y: 0 }, BLUE).fill).toEqual(BLUE);
    }
  });

  it("removes fill from a mixed selection in one collaborative undo step without hiding legacy objects", () => {
    const local = board();
    const remote = board();
    const text = createLayer(LayerType.Text, { x: 0, y: 0 }, RED);
    const path: Layer = { type: LayerType.Path, x: 0, y: 0, width: 50, height: 10, fill: RED, points: [[0, 0], [50, 10]] };
    const ids = local.insert([
      legacy(LayerType.Rectangle, BLUE),
      { ...legacy(LayerType.Ellipse, RED), stroke: { ...BLUE, a: 0 }, strokeWidth: 4 },
      text, path,
    ]);
    const initial = ids.map((id) => local.getLayer(id));
    Y.applyUpdate(remote.doc, Y.encodeStateAsUpdate(local.doc), "peer");
    controls(local, ids);
    expect(picker("Заливка").mixed).toBe(true);
    let updates = 0;
    local.doc.on("update", () => { updates += 1; });
    const history = local.undoManager.undoStack.length;

    fireEvent.click(screen.getByRole("button", { name: "Без заливки" }));
    expect(updates).toBe(1);
    expect(local.undoManager.undoStack).toHaveLength(history + 1);
    expect(shape(local, ids[0])).toMatchObject({ fill: { ...BLUE, a: 0 }, stroke: { ...BLUE, a: 1 }, strokeWidth: 2 });
    expect(shape(local, ids[1])).toMatchObject({ fill: { ...RED, a: 0 }, stroke: { ...RED, a: 1 }, strokeWidth: 2 });
    expect(local.getLayer(ids[2])).toEqual(initial[2]);
    expect(local.getLayer(ids[3])).toEqual(initial[3]);
    expect(picker("Заливка")).toEqual({ value: null, mixed: false });

    Y.applyUpdate(remote.doc, Y.encodeStateAsUpdate(local.doc), "peer");
    expect(ids.map((id) => remote.getLayer(id))).toEqual(ids.map((id) => local.getLayer(id)));
    act(() => local.undo());
    expect(ids.map((id) => local.getLayer(id))).toEqual(initial);
    expect(picker("Заливка").mixed).toBe(true);
    Y.applyUpdate(remote.doc, Y.encodeStateAsUpdate(local.doc), "peer");
    expect(ids.map((id) => remote.getLayer(id))).toEqual(initial);
    act(() => local.redo());
    expect(picker("Заливка")).toEqual({ value: null, mixed: false });
  });

  it("changes outline and fill independently and remembers only the outline for new objects", () => {
    const document = board();
    const [id] = document.insert([createLayer(LayerType.Rectangle, { x: 0, y: 0 }, BLUE)]);
    const lastUsedColor = controls(document, [id]);
    fireEvent.click(screen.getByRole("button", { name: "Заливка: красный" }));
    expect(shape(document, id)).toMatchObject({ fill: RED, stroke: { ...BLUE, a: 1 } });
    expect(lastUsedColor).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Контур: красный" }));
    expect(shape(document, id)).toMatchObject({ fill: RED, stroke: RED, strokeWidth: 2 });
    expect(lastUsedColor).toHaveBeenCalledWith(RED);
    fireEvent.click(screen.getByRole("button", { name: "Без заливки" }));
    expect(shape(document, id)).toMatchObject({ fill: { ...RED, a: 0 }, stroke: RED });
    expect(lastUsedColor).toHaveBeenCalledTimes(1);
  });

  it("refreshes current values after a peer changes the selected shape", () => {
    const local = board();
    const remote = board();
    const [id] = local.insert([createLayer(LayerType.Ellipse, { x: 0, y: 0 }, BLUE)]);
    Y.applyUpdate(remote.doc, Y.encodeStateAsUpdate(local.doc), "peer");
    controls(local, [id]);
    remote.update([id], { fill: RED, stroke: RED });
    act(() => Y.applyUpdate(local.doc, Y.encodeStateAsUpdate(remote.doc), "peer"));
    expect(picker("Заливка")).toEqual({ value: RED, mixed: false });
    expect(picker("Контур")).toEqual({ value: RED, mixed: false });
  });
});
