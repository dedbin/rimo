"use client";

import { useEffect, useId, useState } from "react";
import { Crosshair, Minus, Plus, RotateCcw } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { createGraphSettings, parseGraphViewport } from "@/lib/board/graph/model";
import type { GraphViewport } from "@/types/board-canvas";

interface GraphViewportControlsProps {
  readonly viewport: GraphViewport;
  onChange: (viewport: GraphViewport) => void;
}

type RangeDraft = Record<keyof GraphViewport, string>;

function rangeDraft(viewport: GraphViewport): RangeDraft {
  return { xMin: String(viewport.xMin), xMax: String(viewport.xMax),
    yMin: String(viewport.yMin), yMax: String(viewport.yMax) };
}

function zoomViewport(viewport: GraphViewport, factor: number): GraphViewport | null {
  const centerX = (viewport.xMin + viewport.xMax) / 2;
  const centerY = (viewport.yMin + viewport.yMax) / 2;
  const halfX = (viewport.xMax - viewport.xMin) * factor / 2;
  const halfY = (viewport.yMax - viewport.yMin) * factor / 2;
  return parseGraphViewport({ xMin: centerX - halfX, xMax: centerX + halfX,
    yMin: centerY - halfY, yMax: centerY + halfY });
}

export function GraphViewportControls({ viewport, onChange }: GraphViewportControlsProps) {
  const [draft, setDraft] = useState(() => rangeDraft(viewport));
  const [error, setError] = useState<string | null>(null);
  const prefix = useId();
  const { xMin, xMax, yMin, yMax } = viewport;
  useEffect(() => {
    setDraft(rangeDraft({ xMin, xMax, yMin, yMax }));
    setError(null);
  }, [xMin, xMax, yMin, yMax]);
  const zoomIn = zoomViewport(viewport, 0.8);
  const zoomOut = zoomViewport(viewport, 1.25);

  const apply = () => {
    if (Object.values(draft).some((value) => !value.trim())) {
      setError("Заполните все четыре границы области.");
      return;
    }
    const next = parseGraphViewport({ xMin: Number(draft.xMin), xMax: Number(draft.xMax),
      yMin: Number(draft.yMin), yMax: Number(draft.yMax) });
    if (!next) {
      setError("Укажите возрастающие границы от −1 000 000 до 1 000 000. Диапазон каждой оси — от 0,0001 до 1 000 000.");
      return;
    }
    setError(null);
    onChange(next);
  };

  return <div className="space-y-3">
    <div className="flex gap-1" role="group" aria-label="Масштаб и центр графика">
      <Button type="button" variant="outline" size="icon" aria-label="Приблизить график"
        title="Приблизить график" disabled={!zoomIn} onClick={() => { if (zoomIn) onChange(zoomIn); }}><Plus /></Button>
      <Button type="button" variant="outline" size="icon" aria-label="Отдалить график"
        title="Отдалить график" disabled={!zoomOut} onClick={() => { if (zoomOut) onChange(zoomOut); }}><Minus /></Button>
      <Button type="button" variant="outline" size="icon" aria-label="К началу координат"
        title="К началу координат" onClick={() => onChange({
          xMin: -(viewport.xMax - viewport.xMin) / 2, xMax: (viewport.xMax - viewport.xMin) / 2,
          yMin: -(viewport.yMax - viewport.yMin) / 2, yMax: (viewport.yMax - viewport.yMin) / 2,
        })}><Crosshair /></Button>
      <Button type="button" variant="ghost" size="sm" className="ml-auto" aria-label="Сбросить область графика"
        title="Вернуть исходную область" onClick={() => onChange(createGraphSettings().viewport)}><RotateCcw />Сбросить</Button>
    </div>
    <form onSubmit={(event) => { event.preventDefault(); apply(); }} className="space-y-2.5">
      <div className="grid grid-cols-2 gap-x-3 gap-y-2">
        {([['xMin', 'X от', 'Минимум X'], ['xMax', 'X до', 'Максимум X'],
          ['yMin', 'Y от', 'Минимум Y'], ['yMax', 'Y до', 'Максимум Y']] as const).map(([key, label, ariaLabel]) =>
          <label key={key} className="space-y-1 text-xs text-neutral-600" htmlFor={`${prefix}-${key}`}>
            <span>{label}</span>
            <Input id={`${prefix}-${key}`} type="number" inputMode="decimal" step="any" aria-label={ariaLabel}
              aria-invalid={!!error} aria-describedby={error ? `${prefix}-error` : undefined} value={draft[key]}
              className="h-9 bg-white font-mono text-sm" onChange={(event) => {
                setDraft((current) => ({ ...current, [key]: event.target.value }));
                setError(null);
              }} />
          </label>)}
      </div>
      {error && <p id={`${prefix}-error`} role="alert" className="text-xs leading-relaxed text-red-600">{error}</p>}
      <Button type="submit" variant="outline" size="sm" className="w-full">Применить границы</Button>
    </form>
  </div>;
}
