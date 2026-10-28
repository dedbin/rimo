"use client";

import { useTranslation } from "@/hooks/use-translation";
import { isShape, samePaint, shapeFillPatch, shapeStroke } from "@/lib/board/shape-style";
import type { Paint } from "@/lib/board/shape-style";
import { useBoardRuntime, useBoardSnapshot, useSelection } from "@/lib/collaboration/react";
import type { Color } from "@/types/board-canvas";
import { PaintPicker } from "./paint-picker";

export function ShapeColorControls({ setLastUsedColor }: { setLastUsedColor: (color: Color) => void }) {
  const runtime = useBoardRuntime();
  const snapshot = useBoardSnapshot();
  const selection = useSelection();
  const { t } = useTranslation();
  const shapes = selection.map((id) => snapshot.layers.get(id)).filter(isShape);
  if (!shapes.length) return null;

  const strokes = shapes.map(shapeStroke);
  const fills = shapes.map((layer) => layer.fill.a === 0 ? null : layer.fill);
  const setStroke = (color: Paint) => {
    if (!color) return;
    setLastUsedColor(color);
    runtime.board.transact(() => {
      for (const id of selection) {
        const layer = runtime.board.getLayer(id);
        if (isShape(layer)) runtime.board.update([id], { stroke: color, strokeWidth: shapeStroke(layer) ? layer.strokeWidth : 2 });
      }
    });
  };
  const setFill = (color: Paint) => runtime.board.transact(() => {
    for (const id of selection) {
      const layer = runtime.board.getLayer(id);
      if (isShape(layer)) runtime.board.update([id], shapeFillPatch(layer, color));
    }
  });

  return <div className="flex items-center gap-1">
    <PaintPicker label={t("selectionTools.outline")} value={strokes[0]} mixed={strokes.some((color) => !samePaint(color, strokes[0]))}
      onChange={setStroke} outline />
    <PaintPicker label={t("selectionTools.fill")} value={fills[0]} mixed={fills.some((color) => !samePaint(color, fills[0]))}
      emptyLabel={t("selectionTools.noFill")} onChange={setFill} />
  </div>;
}
