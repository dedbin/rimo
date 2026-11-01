import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { GraphEditor } from "@/components/board-graph/editor";
import { GraphEditorProvider, useGraphEditor } from "@/components/board-graph/provider";
import { createLayer } from "@/lib/board/model";
import { BoardDocument } from "@/lib/collaboration/document";
import { BoardRuntimeContext } from "@/lib/collaboration/react";
import type { BoardRuntime } from "@/lib/collaboration/runtime";
import { LayerType } from "@/types/board-canvas";
import type { GraphLayer } from "@/types/board-canvas";

let board: BoardDocument;
let graphId: string;

function Launcher() {
  const editor = useGraphEditor();
  return <>
    <button type="button" onClick={() => editor.open(graphId)}>Открыть график</button>
    <output data-testid="editor-state">{JSON.stringify({ editingId: editor.editingId, navigationId: editor.navigationId })}</output>
  </>;
}

function setup() {
  const runtime = { board } as unknown as BoardRuntime;
  render(<BoardRuntimeContext.Provider value={runtime}>
    <GraphEditorProvider><Launcher /><GraphEditor /></GraphEditorProvider>
  </BoardRuntimeContext.Provider>);
  fireEvent.click(screen.getByRole("button", { name: "Открыть график" }));
}

const graph = (): GraphLayer => board.getLayer(graphId) as GraphLayer;

beforeEach(() => {
  board = new BoardDocument();
  [graphId] = board.insert([createLayer(LayerType.Graph, { x: 100, y: 100 }, { r: 0, g: 0, b: 0 })]);
});
afterEach(() => { cleanup(); board.destroy(); });

describe("graph editor", () => {
  it("keeps incomplete formulas editable without changing another row and edits visibility and color independently", () => {
    setup();
    const second = { ...graph().graph.expressions.line };
    fireEvent.change(screen.getByLabelText("Формула 1"), { target: { value: "y = sqrt(" } });
    expect(graph().graph.expressions.parabola.formula).toBe("y = sqrt(");
    expect(screen.getByLabelText("Формула 1").getAttribute("aria-invalid")).toBe("true");
    expect(graph().graph.expressions.line).toEqual(second);
    expect(screen.getByLabelText("Формула 2").getAttribute("aria-invalid")).toBe("false");

    fireEvent.change(screen.getByLabelText("Формула 1"), { target: { value: "y <= 2x + 1" } });
    expect(screen.getByLabelText("Формула 1").getAttribute("aria-invalid")).toBe("false");
    fireEvent.click(screen.getByRole("button", { name: "Скрыть график 1" }));
    fireEvent.change(screen.getByLabelText("Цвет графика 1"), { target: { value: "#059669" } });
    expect(graph().graph.expressions.parabola).toMatchObject({ formula: "y <= 2x + 1", color: "#059669", visible: false });
    expect(graph().graph.expressions.line).toEqual(second);
    fireEvent.click(screen.getByRole("button", { name: "Показать график 1" }));
    expect(graph().graph.expressions.parabola.visible).toBe(true);
  });

  it("adds the next row with Enter, focuses it and enforces the expression limit", () => {
    setup();
    fireEvent.keyDown(screen.getByLabelText("Формула 2"), { key: "Enter" });
    expect(Object.keys(graph().graph.expressions)).toHaveLength(3);
    expect(document.activeElement).toBe(screen.getByLabelText("Формула 3"));
    fireEvent.keyDown(screen.getByLabelText("Формула 3"), { key: "Enter" });
    expect(Object.keys(graph().graph.expressions)).toHaveLength(3);
    for (let index = 3; index < 12; index += 1) fireEvent.click(screen.getByRole("button", { name: "Добавить формулу" }));
    expect(Object.keys(graph().graph.expressions)).toHaveLength(12);
    expect((screen.getByRole("button", { name: "Добавить формулу" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Удалить формулу 12" }));
    expect(Object.keys(graph().graph.expressions)).toHaveLength(11);
    expect((screen.getByRole("button", { name: "Добавить формулу" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("validates range drafts before saving and preserves them while formulas change", () => {
    setup();
    const initial = { ...graph().graph.viewport };
    fireEvent.change(screen.getByLabelText("Минимум X"), { target: { value: "20" } });
    fireEvent.click(screen.getByRole("button", { name: "Применить границы" }));
    expect(screen.getByRole("alert").textContent).toContain("возрастающие границы");
    expect(graph().graph.viewport).toEqual(initial);

    fireEvent.change(screen.getByLabelText("Минимум X"), { target: { value: "-12" } });
    fireEvent.change(screen.getByLabelText("Формула 1"), { target: { value: "y = sin(x)" } });
    expect((screen.getByLabelText("Минимум X") as HTMLInputElement).value).toBe("-12");
    expect(graph().graph.viewport).toEqual(initial);
    fireEvent.keyDown(screen.getByLabelText("Максимум X"), { key: "Enter" });
    fireEvent.submit(screen.getByLabelText("Максимум X").closest("form")!);
    expect(graph().graph.viewport).toEqual({ ...initial, xMin: -12 });

    fireEvent.click(screen.getByRole("button", { name: "Приблизить график" }));
    expect(graph().graph.viewport.xMax - graph().graph.viewport.xMin).toBeCloseTo(16);
    fireEvent.click(screen.getByLabelText("Показывать сетку"));
    expect(graph().graph.showGrid).toBe(false);
  });

  it("keeps board shortcuts out of the panel and exits graph navigation before closing on Escape", () => {
    setup();
    const boardShortcut = vi.fn();
    document.addEventListener("keydown", boardShortcut);
    try {
      fireEvent.keyDown(screen.getByLabelText("Формула 1"), { key: "Delete" });
      expect(boardShortcut).not.toHaveBeenCalled();
      fireEvent.click(screen.getByRole("button", { name: "Двигать оси" }));
      expect(screen.getByRole("button", { name: "Двигать оси" }).getAttribute("aria-pressed")).toBe("true");
      fireEvent.keyDown(screen.getByRole("complementary", { name: "Редактор графика" }), { key: "Escape" });
      expect(screen.getByRole("button", { name: "Двигать оси" }).getAttribute("aria-pressed")).toBe("false");
      expect(screen.getByRole("complementary", { name: "Редактор графика" })).toBeTruthy();
      fireEvent.keyDown(screen.getByLabelText("Формула 1"), { key: "Escape" });
      expect(screen.queryByRole("complementary", { name: "Редактор графика" })).toBeNull();
      expect(screen.getByTestId("editor-state").textContent).toBe(JSON.stringify({ editingId: null, navigationId: null }));
    } finally { document.removeEventListener("keydown", boardShortcut); }
    act(() => board.setWritable(false));
    fireEvent.click(screen.getByRole("button", { name: "Открыть график" }));
    expect(screen.queryByRole("complementary", { name: "Редактор графика" })).toBeNull();
  });
});
