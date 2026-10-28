"use client";

import { memo, PointerEvent } from "react";
import { useActiveSelectionArea } from "@/hooks/use-selection-bounds";
import { LayerType, side, XYWH } from "@/types/board-canvas";
import { useBoardRuntime, useLayer, useSelection } from "@/lib/collaboration/react";

interface SelectionBoxProps {
  onResizeHandlePointerDown: (corner: side, initialBounds: XYWH, event: PointerEvent) => void;
  boundsOverride?: XYWH | null;
}

const HANDLE_SIZE = 8;
const handles = [
  { corner: side.top | side.left, x: 0, y: 0, cursor: "nwse-resize" },
  { corner: side.top, x: 0.5, y: 0, cursor: "ns-resize" },
  { corner: side.top | side.right, x: 1, y: 0, cursor: "nesw-resize" },
  { corner: side.right, x: 1, y: 0.5, cursor: "ew-resize" },
  { corner: side.bottom | side.right, x: 1, y: 1, cursor: "nwse-resize" },
  { corner: side.bottom, x: 0.5, y: 1, cursor: "ns-resize" },
  { corner: side.bottom | side.left, x: 0, y: 1, cursor: "nesw-resize" },
  { corner: side.left, x: 0, y: 0.5, cursor: "ew-resize" },
];

export const SelectionBox = memo(({ onResizeHandlePointerDown, boundsOverride }: SelectionBoxProps) => {
  const { board } = useBoardRuntime();
  const selection = useSelection();
  const layer = useLayer(selection.length === 1 ? selection[0] : "");
  const storedBounds = useActiveSelectionArea();
  const bounds = boundsOverride ?? storedBounds;
  if (!bounds) return null;
  const showHandles = board.canEdit && selection.length === 1 && layer?.type !== LayerType.Path;
  return <>
    <rect className="fill-transparent stroke-green-500 stroke-3 pointer-events-none"
      x={bounds.x} y={bounds.y} width={bounds.width} height={bounds.height} />
    {showHandles && handles.map((handle) => <rect key={handle.corner}
      className="fill-white stroke-1 stroke-blue-500" width={HANDLE_SIZE} height={HANDLE_SIZE}
      x={bounds.x + bounds.width * handle.x - HANDLE_SIZE / 2}
      y={bounds.y + bounds.height * handle.y - HANDLE_SIZE / 2}
      style={{ cursor: handle.cursor }} onPointerDown={(event) => {
        event.stopPropagation();
        onResizeHandlePointerDown(handle.corner, storedBounds ?? bounds, event);
      }} />)}
  </>;
});
SelectionBox.displayName = "SelectionBox";
