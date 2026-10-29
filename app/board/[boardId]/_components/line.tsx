"use client";

import type { PointerEvent } from "react";

import { rgbToCss } from "@/lib/board/colors";
import { clipLineToBounds, lineArrowPoints, lineEndpoints } from "@/lib/board/line";
import type { LineLayer, XYWH } from "@/types/board-canvas";

interface LineProps {
  id: string;
  layer: LineLayer;
  onPointerDown?: (event: PointerEvent, id: string) => void;
  selectionColor?: string;
  viewport?: XYWH;
}

export function Line({ id, layer, onPointerDown, selectionColor, viewport }: LineProps) {
  const points = layer.lineKind === "line"
    ? clipLineToBounds(layer, viewport ?? { x: -1_000_000, y: -1_000_000, width: 2_000_000, height: 2_000_000 })
    : lineEndpoints(layer);
  if (!points) return null;
  const [start, end] = points;
  const stroke = rgbToCss(layer.fill);
  const arrows = layer.lineKind === "segment" ? [
    ...(layer.startArrow ? [{ name: "start", points: lineArrowPoints(start, end, layer.strokeWidth) }] : []),
    ...(layer.endArrow ? [{ name: "end", points: lineArrowPoints(end, start, layer.strokeWidth) }] : []),
  ] : [];

  return <g onPointerDown={onPointerDown ? (event) => onPointerDown(event, id) : undefined}
    pointerEvents={onPointerDown ? undefined : "none"}>
    {selectionColor && <line x1={start.x} y1={start.y} x2={end.x} y2={end.y}
      stroke={selectionColor} strokeWidth={layer.strokeWidth + 4} strokeLinecap="round" pointerEvents="none" />}
    <line data-line-body="true" data-line-kind={layer.lineKind}
      x1={start.x} y1={start.y} x2={end.x} y2={end.y}
      stroke={stroke} strokeWidth={layer.strokeWidth} strokeLinecap="round" pointerEvents={onPointerDown ? "stroke" : "none"} />
    {onPointerDown && <line data-line-hit="true" x1={start.x} y1={start.y} x2={end.x} y2={end.y}
      stroke="transparent" strokeWidth={Math.max(16, layer.strokeWidth + 8)} strokeLinecap="round"
      vectorEffect="non-scaling-stroke" pointerEvents="stroke" />}
    {arrows.map((arrow) => <polygon key={arrow.name} data-line-arrow={arrow.name} points={arrow.points}
      fill={stroke} stroke={selectionColor} strokeWidth={selectionColor ? 2 : 0}
      strokeLinejoin="round" pointerEvents={onPointerDown ? "all" : "none"} />)}
  </g>;
}
