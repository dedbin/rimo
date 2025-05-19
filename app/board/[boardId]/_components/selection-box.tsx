"use client";

import { useActiveSelectionArea } from "@/hooks/use-selection-bounds";
import { LayerType, side, XYWH } from "@/types/board-canvas";
import { useSelf, useStorage } from "@liveblocks/react/suspense";
import { memo } from "react";

interface SelectionBoxProps {
   onResizeHandlePointerDown: (corner: side, initialBounds: XYWH) => void;
}

const HANDLE_SIZE = 8;

export const SelectionBox = memo<SelectionBoxProps>(({ onResizeHandlePointerDown }: SelectionBoxProps) => {
  const soleLayerId = useSelf((me)=>
    me.presence.selection.length === 1 ? me.presence.selection[0] : undefined
  );

  const isShowingHandles = useStorage((root) =>soleLayerId && root.layers.get(soleLayerId)?.type !== LayerType.Path);
  const bounds = useActiveSelectionArea();

    if (!bounds) return null;

    return (
      <>
      <rect
        className="fill-transparent stroke-green-500 stroke-3 pointer-events-none"
        style={{ transform: `translate(${bounds?.x}px, ${bounds?.y}px)` }}
        width={bounds?.width}
        height={bounds?.height}
        x={0}
        y={0}
      />
      {isShowingHandles && (
        <>
        <rect
          className="fill-white stroke-1 stroke-blue-500"
          x={0}
          y={0}
          style={{
              cursor: "nwse-resize",
              width: `${HANDLE_SIZE}px`,
              height: `${HANDLE_SIZE}px`,
              transform: `translate(${bounds.x - HANDLE_SIZE / 2}px, ${bounds.y - HANDLE_SIZE / 2}px)`,
          }}
          onPointerDown={(e) => {
              e.stopPropagation();
              onResizeHandlePointerDown(side.top + side.left, bounds);
          }}
        />
        <rect
            className="fill-white stroke-1 stroke-blue-500"
            x={0}
            y={0}
            style={{
                cursor: "ns-resize",
                width: `${HANDLE_SIZE}px`,
                height: `${HANDLE_SIZE}px`,
                transform: `translate(${bounds.x + bounds.width / 2 - HANDLE_SIZE / 2}px, ${bounds.y - HANDLE_SIZE / 2}px)`,
            }}
            onPointerDown={(e) => {
                e.stopPropagation();
                onResizeHandlePointerDown(side.top, bounds);
            }}
        />
        <rect
            className="fill-white stroke-1 stroke-blue-500"
            x={0}
            y={0}
            style={{
                cursor: "nesw-resize",
                width: `${HANDLE_SIZE}px`,
                height: `${HANDLE_SIZE}px`,
                transform: `translate(${bounds.x + bounds.width - HANDLE_SIZE / 2}px, ${bounds.y - HANDLE_SIZE / 2}px)`,
            }}
            onPointerDown={(e) => {
                e.stopPropagation();
                onResizeHandlePointerDown(side.top + side.right, bounds);
            }}
        />
        <rect
            className="fill-white stroke-1 stroke-blue-500"
            x={0}
            y={0}
            style={{
                cursor: "ew-resize",
                width: `${HANDLE_SIZE}px`,
                height: `${HANDLE_SIZE}px`,
                transform: `translate(${bounds.x + bounds.width - HANDLE_SIZE / 2}px, ${bounds.y + bounds.height / 2 - HANDLE_SIZE / 2}px)`,
            }}
            onPointerDown={(e) => {
                e.stopPropagation();
                onResizeHandlePointerDown(side.right, bounds);
            }}
        />
        <rect
            className="fill-white stroke-1 stroke-blue-500"
            x={0}
            y={0}
            style={{
                cursor: "nwse-resize",
                width: `${HANDLE_SIZE}px`,
                height: `${HANDLE_SIZE}px`,
                transform: `translate(${bounds.x + bounds.width - HANDLE_SIZE / 2}px, ${bounds.y + bounds.height - HANDLE_SIZE / 2}px)`,
            }}
            onPointerDown={(e) => {
                e.stopPropagation();
                onResizeHandlePointerDown(side.bottom + side.right, bounds);
            }}
        />
        <rect
            className="fill-white stroke-1 stroke-blue-500"
            x={0}
            y={0}
            style={{
                cursor: "ns-resize",
                width: `${HANDLE_SIZE}px`,
                height: `${HANDLE_SIZE}px`,
                transform: `translate(${bounds.x + bounds.width / 2 - HANDLE_SIZE / 2}px, ${bounds.y + bounds.height - HANDLE_SIZE / 2}px)`,
            }}
            onPointerDown={(e) => {
                e.stopPropagation();
                onResizeHandlePointerDown(side.bottom, bounds);
            }}
        />
        <rect
            className="fill-white stroke-1 stroke-blue-500"
            x={0}
            y={0}
            style={{
                cursor: "nesw-resize",
                width: `${HANDLE_SIZE}px`,
                height: `${HANDLE_SIZE}px`,
                transform: `translate(${bounds.x - HANDLE_SIZE / 2}px, ${bounds.y + bounds.height - HANDLE_SIZE / 2}px)`,
            }}
            onPointerDown={(e) => {
                e.stopPropagation();
                onResizeHandlePointerDown(side.bottom + side.left, bounds);
            }}
        />
        <rect
            className="fill-white stroke-1 stroke-blue-500"
            x={0}
            y={0}
            style={{
                cursor: "ew-resize",
                width: `${HANDLE_SIZE}px`,
                height: `${HANDLE_SIZE}px`,
                transform: `translate(${bounds.x - HANDLE_SIZE / 2}px, ${bounds.y + bounds.height / 2 - HANDLE_SIZE / 2}px)`,
            }}
            onPointerDown={(e) => {
                e.stopPropagation();
                onResizeHandlePointerDown(side.left, bounds);
            }}
        />
        </>
      )}
    </>
    )
  });

  


SelectionBox.displayName = "SelectionBox";