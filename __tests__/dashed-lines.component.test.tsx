import { useState } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { LineStyleControls } from "@/app/board/[boardId]/_components/line-style-controls";
import { LineTool } from "@/app/board/[boardId]/_components/line-tool";
import { createLine } from "@/lib/board/line";
import { createLayer } from "@/lib/board/model";
import { BoardDocument } from "@/lib/collaboration/document";
import { emptyPresence } from "@/lib/collaboration/presence";
import { BoardRuntimeContext } from "@/lib/collaboration/react";
import type { BoardRuntime } from "@/lib/collaboration/runtime";
import { BoardCanvasMode, LayerType } from "@/types/board-canvas";
import type { BoardCanvasState } from "@/types/board-canvas";

vi.mock("@/hooks/use-translation", () => ({
  useTranslation: () => ({ t: (key: string) => {
    const labels: Record<string, string> = {
      "lineTools.label": "Прямые и отрезки", "lineTools.strokeStyle": "Стиль линии",
      "lineTools.solid": "Сплошная", "lineTools.dashed": "Пунктирная", "lineTools.mixed": "Разные",
      "lineTools.line": "Прямая", "lineTools.segment": "Отрезок",
    };
    return labels[key] ?? key;
  } }),
}));

const documents = new Set<BoardDocument>();
const color = { r: 15, g: 23, b: 42 };

function PersonalLineTool() {
  const [state, setState] = useState<BoardCanvasState>({ mode: BoardCanvasMode.None });
  return <>
    <LineTool canvasState={state} setCanvasState={setState} />
    <button onClick={() => setState({ mode: BoardCanvasMode.None })}>Другой инструмент</button>
    <output data-testid="line-state">{JSON.stringify(state)}</output>
  </>;
}

function openTool(): void {
  fireEvent.keyDown(screen.getByRole("button", { name: "Прямые и отрезки" }), { key: "Enter" });
}

afterEach(() => {
  cleanup();
  for (const document of documents) document.destroy();
  documents.clear();
});

describe("line style before construction", () => {
  it("selects dash style before drawing and retains it when switching line kind and tools", () => {
    render(<PersonalLineTool />);
    openTool();
    expect(screen.getByRole("menuitemradio", { name: "Сплошная" }).getAttribute("aria-checked")).toBe("true");
    fireEvent.click(screen.getByRole("menuitemradio", { name: "Пунктирная" }));
    expect(JSON.parse(screen.getByTestId("line-state").textContent!)).toMatchObject({
      mode: BoardCanvasMode.Inserting, layerType: LayerType.Line, lineKind: "segment", strokeStyle: "dashed",
    });
    fireEvent.click(screen.getByRole("menuitemradio", { name: "Прямая" }));
    expect(JSON.parse(screen.getByTestId("line-state").textContent!)).toMatchObject({ lineKind: "line", strokeStyle: "dashed" });
    fireEvent.click(screen.getByRole("button", { name: "Другой инструмент" }));
    openTool();
    expect(screen.getByRole("menuitemradio", { name: "Пунктирная" }).getAttribute("aria-checked")).toBe("true");
    fireEvent.click(screen.getByRole("menuitemradio", { name: "Отрезок" }));
    expect(JSON.parse(screen.getByTestId("line-state").textContent!)).toMatchObject({ lineKind: "segment", strokeStyle: "dashed" });
  });

  it("shows the solid default after a shortcut activates a line without an explicit style", () => {
    const setCanvasState = vi.fn();
    const view = render(<LineTool canvasState={{ mode: BoardCanvasMode.None }} setCanvasState={setCanvasState} />);
    openTool();
    fireEvent.click(screen.getByRole("menuitemradio", { name: "Пунктирная" }));
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
    view.rerender(<LineTool canvasState={{ mode: BoardCanvasMode.Pencil }} setCanvasState={setCanvasState} />);
    view.rerender(<LineTool canvasState={{ mode: BoardCanvasMode.Inserting, layerType: LayerType.Line, lineKind: "segment" }}
      setCanvasState={setCanvasState} />);
    openTool();
    expect(screen.getByRole("menuitemradio", { name: "Сплошная" }).getAttribute("aria-checked")).toBe("true");
    expect(screen.getByRole("menuitemradio", { name: "Пунктирная" }).getAttribute("aria-checked")).toBe("false");
  });
});

describe("selected line style", () => {
  it("shows mixed styles and updates only selected lines in one undoable transaction", () => {
    const document = new BoardDocument();
    documents.add(document);
    const legacy = createLine({ x: 0, y: 0 }, { x: 100, y: 0 }, color);
    delete legacy.strokeStyle;
    const ids = document.insert([
      legacy, createLine({ x: 0, y: 100 }, { x: 100, y: 100 }, color, "line", "dashed"),
      createLayer(LayerType.Rectangle, { x: 200, y: 0 }, color),
    ]);
    const initial = ids.map((id) => document.getLayer(id));
    const presence = { ...emptyPresence(), selection: ids };
    const runtime = { board: document, getSelf: () => ({ presence }), subscribePresence: () => () => {} } as unknown as BoardRuntime;
    render(<BoardRuntimeContext.Provider value={runtime}>
      <LineStyleControls setLastUsedColor={vi.fn()} />
    </BoardRuntimeContext.Provider>);
    fireEvent.keyDown(screen.getByRole("button", { name: "Стиль линии: Разные" }), { key: "Enter" });
    expect(screen.getByRole("menuitemradio", { name: "Сплошная" }).getAttribute("aria-checked")).toBe("false");
    expect(screen.getByRole("menuitemradio", { name: "Пунктирная" }).getAttribute("aria-checked")).toBe("false");
    const history = document.undoManager.undoStack.length;
    let updates = 0;
    document.doc.on("update", () => { updates += 1; });
    fireEvent.click(screen.getByRole("menuitemradio", { name: "Пунктирная" }));
    expect(updates).toBe(1);
    expect(document.undoManager.undoStack).toHaveLength(history + 1);
    expect(document.getLayer(ids[0])).toMatchObject({ strokeStyle: "dashed" });
    expect(document.getLayer(ids[1])).toMatchObject({ strokeStyle: "dashed" });
    expect(document.getLayer(ids[2])).toEqual(initial[2]);
    expect(screen.getByRole("button", { name: "Стиль линии: Пунктирная" })).toBeDefined();
    act(() => document.undo());
    expect(ids.map((id) => document.getLayer(id))).toEqual(initial);
    expect(screen.getByRole("button", { name: "Стиль линии: Разные" })).toBeDefined();
    act(() => document.redo());
    expect(screen.getByRole("button", { name: "Стиль линии: Пунктирная" })).toBeDefined();
  });
});
