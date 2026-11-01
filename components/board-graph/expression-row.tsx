"use client";

import { useMemo } from "react";
import { Eye, EyeOff, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { compileGraphExpression } from "@/lib/board/graph/expression";
import { MAX_GRAPH_FORMULA_LENGTH } from "@/lib/board/graph/model";
import type { GraphExpression } from "@/types/board-canvas";

interface GraphExpressionRowProps {
  readonly id: string;
  readonly index: number;
  readonly expression: GraphExpression;
  readonly autoFocus?: boolean;
  readonly canAdd?: boolean;
  onChange: (patch: Partial<GraphExpression>) => void;
  onRemove: () => void;
  onSubmit: () => void;
}

export function GraphExpressionRow({ id, index, expression, autoFocus, canAdd,
  onChange, onRemove, onSubmit }: GraphExpressionRowProps) {
  const compiled = useMemo(() => compileGraphExpression(expression.formula), [expression.formula]);
  const error = expression.formula.trim() && !compiled.ok ? compiled.error : null;
  const errorId = `graph-expression-error-${id}`;
  const number = index + 1;

  return <li className="rounded-lg border border-neutral-200 bg-white p-2.5" data-graph-expression-id={id}>
    <div className="mb-2 flex items-center gap-1">
      <label className="relative mr-1 flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-md border border-neutral-200 focus-within:ring-2 focus-within:ring-blue-500 focus-within:ring-offset-1"
        title={`Цвет графика ${number}`}>
        <span aria-hidden="true" className="size-4 rounded-full" style={{ backgroundColor: expression.color }} />
        <input type="color" aria-label={`Цвет графика ${number}`} value={expression.color}
          className="absolute inset-0 size-full cursor-pointer opacity-0"
          onChange={(event) => onChange({ color: event.target.value })} />
      </label>
      <span className="mr-auto text-xs font-medium text-neutral-500">{number}</span>
      <Button type="button" variant="ghost" className="size-8" size="icon"
        aria-label={`${expression.visible ? "Скрыть" : "Показать"} график ${number}`}
        aria-pressed={expression.visible} title={expression.visible ? "Скрыть график" : "Показать график"}
        onClick={() => onChange({ visible: !expression.visible })}>
        {expression.visible ? <Eye /> : <EyeOff />}
      </Button>
      <Button type="button" variant="ghost" className="size-8 text-neutral-500 hover:text-red-600" size="icon"
        aria-label={`Удалить формулу ${number}`} title="Удалить формулу" onClick={onRemove}>
        <Trash2 />
      </Button>
    </div>
    <Input aria-label={`Формула ${number}`} value={expression.formula} autoFocus={autoFocus}
      placeholder="y = x^2" autoComplete="off" spellCheck={false} autoCapitalize="off"
      maxLength={MAX_GRAPH_FORMULA_LENGTH} aria-invalid={!!error}
      aria-describedby={error ? errorId : undefined}
      className={`h-10 bg-neutral-50 font-mono text-[15px] ${expression.visible ? "" : "text-neutral-400"}`}
      onChange={(event) => onChange({ formula: event.target.value.slice(0, MAX_GRAPH_FORMULA_LENGTH) })}
      onKeyDown={(event) => {
        if (event.key === "Enter" && !event.nativeEvent.isComposing) {
          event.preventDefault();
          if (!error && expression.formula.trim() && canAdd) onSubmit();
        }
      }} />
    {error && <p id={errorId} className="mt-1.5 text-xs leading-relaxed text-red-600" aria-live="polite">{error}</p>}
  </li>;
}
