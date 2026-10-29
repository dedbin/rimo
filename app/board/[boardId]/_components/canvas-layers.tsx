"use client";

import { memo, type PointerEvent } from "react";

import type { BoardSnapshot } from "@/lib/collaboration/document";
import type { Point, XYWH } from "@/types/board-canvas";
import { LayerType } from "@/types/board-canvas";
import type { LineLayer } from "@/types/board-canvas";

import { LayerPreview } from "./layer-preview";

interface CanvasLayersProps {
  readonly snapshot: BoardSnapshot;
  readonly visibleIds: readonly string[];
  readonly movingIds: ReadonlySet<string>;
  readonly previewIds: readonly string[];
  readonly erased: ReadonlySet<string> | null;
  readonly resize: XYWH | null;
  readonly sharedTranslation?: boolean;
  readonly remoteTransforms: ReadonlyMap<string, Point>;
  readonly selectionColors: Readonly<Record<string, string>>;
  readonly onLayerPointerDown: (event: PointerEvent, id: string) => void;
  readonly viewport?: XYWH;
  readonly linePreview?: LineLayer | null;
  readonly lineDelta?: Point;
}

/** Preview deltas live on the parent; ordinary drag frames keep these nodes. */
export const CanvasLayers = memo(function CanvasLayers({ snapshot, visibleIds, movingIds, previewIds,
  erased, resize, sharedTranslation = false, remoteTransforms, selectionColors, onLayerPointerDown, viewport, linePreview, lineDelta }: CanvasLayersProps) {
  // A single keyed sibling list preserves text/images while raising moving layers.
  const ids = [...visibleIds.filter((id) => !movingIds.has(id)), ...previewIds];
  return <>{ids.map((id) => {
    const stored = snapshot.layers.get(id);
    if (!stored || erased?.has(id)) return null;
    const moving = movingIds.has(id);
    const remote = remoteTransforms.get(id);
    const offset = moving ? lineDelta : remote;
    const lineViewport = stored.type === LayerType.Line ? viewport && offset
      ? { ...viewport, x: viewport.x - offset.x, y: viewport.y - offset.y } : viewport : undefined;
    return <g key={id} data-layer-id={id} data-preview-layer={moving ? "true" : undefined}
      style={moving && !sharedTranslation ? { transform: "translate(var(--rimo-preview-x), var(--rimo-preview-y))" } : undefined}
      transform={!moving && remote ? `translate(${remote.x} ${remote.y})` : undefined}>
      <LayerPreview id={id} onLayerPointerDown={onLayerPointerDown} selectionColor={selectionColors[id]}
        viewport={lineViewport}
        layerOverride={moving && linePreview ? linePreview : moving && resize ? { ...stored, ...resize } : undefined} />
    </g>;
  })}</>;
});
