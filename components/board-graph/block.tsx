"use client";

import { memo, type PointerEvent } from "react";
import dynamic from "next/dynamic";

import type { GraphLayer } from "@/types/board-canvas";
import { useGraphEditor } from "./provider";
import { useGraphNavigation } from "./use-navigation";

const GraphPlot = dynamic(() => import("@/lib/board/graph/plot").then((module) => module.GraphPlot), {
  ssr: false,
  loading: () => <div role="status" className="flex h-full items-center justify-center bg-white text-sm text-neutral-400">Загрузка графика…</div>,
});

interface Props {
  id: string;
  layer: GraphLayer;
  selectionColor?: string;
  onPointerDown: (event: PointerEvent, id: string) => void;
}

export const GraphBlock = memo(function GraphBlock({ id, layer, selectionColor, onPointerDown }: Props) {
  const editor = useGraphEditor();
  const interactive = editor.navigationId === id;
  const navigation = useGraphNavigation(id, layer.graph.viewport, interactive);
  const width = Math.max(160, Math.min(960, layer.width));
  const height = Math.max(120, Math.min(720, layer.height));
  return <g transform={`translate(${layer.x} ${layer.y})`} data-graph-layer="true"
    onPointerDown={interactive ? undefined : (event) => onPointerDown(event, id)}
    onDoubleClick={(event) => { event.stopPropagation(); editor.open(id); }}>
    <rect width={layer.width} height={layer.height} rx={4} fill="white" stroke={selectionColor ?? "#d4d4d4"} />
    <svg width={layer.width} height={layer.height} viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" overflow="hidden">
      <foreignObject width={width} height={height}>
        <div ref={navigation.ref} data-graph-interaction={interactive ? "true" : undefined}
          style={{ width, height, pointerEvents: interactive ? "auto" : "none", touchAction: interactive ? "none" : "auto",
            cursor: interactive ? "grab" : "inherit" }}
          onPointerDown={navigation.pointerDown} onPointerMove={navigation.pointerMove}
          onPointerUp={navigation.finish} onPointerCancel={navigation.cancel} onLostPointerCapture={navigation.lostCapture}>
          <GraphPlot width={width} height={height} graph={{ ...layer.graph, viewport: navigation.viewport }} />
        </div>
      </foreignObject>
    </svg>
    {interactive && <rect width={layer.width} height={layer.height} fill="none" stroke="#2563eb" strokeWidth={2}
      pointerEvents="none" strokeDasharray="6 4" />}
  </g>;
});
