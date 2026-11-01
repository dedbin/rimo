"use client";

import { useState } from "react";
import { Move, Plus, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { MAX_GRAPH_EXPRESSIONS, sortedGraphExpressions } from "@/lib/board/graph/model";
import { useBoardRuntime, useLayer } from "@/lib/collaboration/react";
import { LayerType } from "@/types/board-canvas";
import { GraphExpressionRow } from "./expression-row";
import { useGraphEditor } from "./provider";
import { GraphViewportControls } from "./viewport-controls";

const EXAMPLES = [
  { label: "y = x²", formula: "y = x^2" },
  { label: "y = sin(x)", formula: "y = sin(x)" },
  { label: "y ≤ 2x + 1", formula: "y <= 2x + 1" },
  { label: "x ≥ 0", formula: "x >= 0" },
] as const;

export function GraphEditor() {
  const runtime = useBoardRuntime();
  const { editingId, navigationId, close, setNavigation } = useGraphEditor();
  const layer = useLayer(editingId ?? "");
  const [lastAdded, setLastAdded] = useState<{ graphId: string; expressionId: string } | null>(null);
  if (!editingId || layer?.type !== LayerType.Graph || !runtime.board.canEdit) return null;
  const rows = sortedGraphExpressions(layer.graph);
  const visibleCount = rows.filter(([, expression]) => expression.visible).length;
  const canAdd = rows.length < MAX_GRAPH_EXPRESSIONS;
  const navigating = navigationId === editingId;
  const add = (formula = "") => {
    const id = runtime.board.addGraphExpression(editingId, { formula });
    if (id) setLastAdded({ graphId: editingId, expressionId: id });
  };

  return <aside aria-label="Редактор графика" data-board-graph-editor="true"
    className="absolute right-3 top-20 z-30 flex max-h-[calc(100dvh-11rem)] w-[340px] max-w-[calc(100vw-24px)] flex-col overflow-hidden rounded-xl border border-neutral-200 bg-white text-neutral-900 shadow-lg touch-pan-y max-sm:top-auto max-sm:bottom-16 max-sm:max-h-[45dvh] max-sm:w-[calc(100vw-24px)]"
    onPointerDown={(event) => event.stopPropagation()}
    onKeyDown={(event) => {
      event.stopPropagation();
      if (event.key === "Escape") {
        event.preventDefault();
        if (navigating) setNavigation(null);
        else close();
      }
    }}>
    <header className="flex shrink-0 items-center gap-2 border-b border-neutral-200 px-4 py-2.5">
      <h2 className="mr-auto font-semibold">Графики</h2>
      <span className="text-xs tabular-nums text-neutral-400">{rows.length > MAX_GRAPH_EXPRESSIONS
        ? rows.length : `${rows.length}/${MAX_GRAPH_EXPRESSIONS}`}</span>
      <Button type="button" variant="ghost" size="icon" className="size-8"
        aria-label="Закрыть редактор графика" title="Закрыть редактор графика" onClick={close}><X /></Button>
    </header>
    <div className="min-h-0 space-y-4 overflow-y-auto overscroll-contain p-4">
      <p className="text-xs leading-relaxed text-neutral-500">Изменяйте формулы — графики обновятся на доске.</p>
      {visibleCount > MAX_GRAPH_EXPRESSIONS && <p role="status" className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs leading-relaxed text-amber-900">
        Включено: {visibleCount}. Одновременно видны до {MAX_GRAPH_EXPRESSIONS} графиков. Скройте или удалите лишние выражения.
      </p>}
      {rows.length ? <ol className="space-y-2.5">
        {rows.map(([id, expression], index) => <GraphExpressionRow key={`${editingId}-${id}`} id={id} index={index}
          expression={expression} canAdd={canAdd}
          autoFocus={lastAdded?.graphId === editingId ? lastAdded.expressionId === id : index === 0}
          onChange={(patch) => runtime.board.updateGraphExpression(editingId, id, patch)}
          onRemove={() => runtime.board.removeGraphExpression(editingId, id)} onSubmit={() => add()} />)}
      </ol> : <div className="rounded-lg border border-dashed border-neutral-200 px-4 py-5 text-center text-sm text-neutral-500">
        Добавьте функцию или неравенство.
      </div>}
      <div className="space-y-2.5">
        <Button type="button" variant="outline" className="w-full" disabled={!canAdd} onClick={() => add()}>
          <Plus />Добавить формулу
        </Button>
        {!canAdd && <p role="status" className="text-xs text-neutral-500">Можно добавить до {MAX_GRAPH_EXPRESSIONS} выражений в один блок.</p>}
        <details className="text-xs text-neutral-500">
          <summary className="cursor-pointer py-1.5 font-medium hover:text-neutral-800">Примеры и запись формул</summary>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {EXAMPLES.map(({ label, formula }) => <Button key={formula} type="button" size="sm" variant="secondary"
              className="h-8 px-2 font-mono text-xs" disabled={!canAdd} aria-label={`Добавить пример ${formula}`}
              onClick={() => add(formula)}>{label}</Button>)}
          </div>
          <p className="mt-2 leading-relaxed">Степень: x^2. Умножение: 2x или 2*x. Функции: sin, cos, sqrt, abs, ln. Для неравенств используйте &lt;, &gt;, &lt;= или &gt;=.</p>
        </details>
      </div>
      <section className="space-y-2 border-t border-neutral-200 pt-4" aria-label="Управление осями графика">
        <Button type="button" variant={navigating ? "boardActive" : "outline"} className="w-full"
          aria-pressed={navigating} onClick={() => setNavigation(navigating ? null : editingId)}>
          <Move />Двигать оси
        </Button>
        <p className="text-xs leading-relaxed text-neutral-500">{navigating
          ? "Тяните внутри графика, чтобы двигать оси. Колесо меняет масштаб. Esc завершает этот режим."
          : "Включите, чтобы двигать оси внутри графика и менять масштаб колесом."}</p>
      </section>
      <details className="border-t border-neutral-200 pt-3" open>
        <summary className="cursor-pointer py-1 text-sm font-medium">Область и сетка</summary>
        <div className="space-y-3 pt-3">
          <GraphViewportControls key={editingId} viewport={layer.graph.viewport}
            onChange={(viewport) => runtime.board.updateGraphSettings(editingId, { viewport })} />
          <label className="flex min-h-8 cursor-pointer items-center gap-2 text-sm text-neutral-700">
            <input type="checkbox" className="size-4 accent-blue-600" checked={layer.graph.showGrid}
              onChange={(event) => runtime.board.updateGraphSettings(editingId, { showGrid: event.target.checked })} />
            Показывать сетку
          </label>
        </div>
      </details>
    </div>
  </aside>;
}
