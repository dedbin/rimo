"use client";

import { useState, useEffect, memo } from "react";
import { useActiveSelectionArea } from "@/hooks/use-selection-bounds";
import { Camera, Color } from "@/types/board-canvas";
import { useMutation, useSelf } from "@liveblocks/react/suspense";
import { ColorPicker } from "./color-picker";
import { useDeleteLayers } from "@/hooks/use-delete-layers";
import { Button } from "@/components/ui/button";
import { Hint } from "@/components/hint";
import { BringToFront, SendToBack, Trash2 } from "lucide-react";

interface SelectionToolsProps {
  camera: Camera;
  setLastUsedColor: (color: Color) => void;
}

export const SelectionTools = memo(
  ({ camera, setLastUsedColor }: SelectionToolsProps) => {
    const selection = useSelf((me) => me.presence.selection ?? []);
    const bounds = useActiveSelectionArea();
    const deleteLayers = useDeleteLayers();

const moveToBack = useMutation(({ storage }) => {
  const liveLayerIds = storage.get("layerIds");
  const arr = liveLayerIds.toImmutable();
  const indices = arr
    .map((id, idx) => ({ id, idx }))
    .filter(item => selection.includes(item.id))
    .map(item => item.idx)
    .sort((a, b) => a - b);

  
  indices.forEach((origIdx, i) => {
    liveLayerIds.move(origIdx, i);
  });
}, [selection]);


const moveToFront = useMutation(({ storage }) => {
  const liveLayerIds = storage.get("layerIds");
  const arr = liveLayerIds.toImmutable();
  
  const indices = arr
    .map((id, idx) => ({ id, idx }))
    .filter(item => selection.includes(item.id))
    .map(item => item.idx)
    .sort((a, b) => b - a);
  const length = arr.length;
  indices.forEach((origIdx, i) => {
    liveLayerIds.move(origIdx, length - 1 - i);
  });
}, [selection]);


    const setFill = useMutation(
      ({ storage }, fill: Color) => {
        const liveLayers = storage.get("layers");
        setLastUsedColor(fill);
        for (const id of selection) {
          liveLayers.get(id)?.set("fill", fill);
        }
      },
      [selection, setLastUsedColor]
    );

    const [hoveringDelete, setHoveringDelete] = useState(false);

    useEffect(() => {
      setHoveringDelete(false);
    }, [selection]);

    if (!bounds || selection.length === 0) {
      return null;
    }

    const x = bounds.x * camera.scale
               + (bounds.width * camera.scale) / 2
               + camera.x;
     const y = bounds.y * camera.scale
               + camera.y;

    return (
      <div
        className="absolute p-3 rounded-xl bg-white shadow-sm border flex items-center select-none"
        style={{
         transform: `translate(
           calc(${x}px - 50%),
           calc(${(y - 10 * camera.scale)}px - 100%)
         )`,
        }}
      >
        <ColorPicker onChange={setFill} />
        <div className="flex flex-col gap-y-0.5 justify-center ml-3">
          <Hint label="bring to front">
            <Button variant="ghost" size="icon" onClick={moveToFront}>
              <BringToFront />
            </Button>
          </Hint>
          <Hint label="send to back" side="bottom">
            <Button variant="ghost" size="icon" onClick={moveToBack}>
              <SendToBack />
            </Button>
          </Hint>
        </div>
        <div className="flex items-center pl-2 ml-2 border-l border-neutral-200">
          <Hint label="delete" side="right" sideOffset={10}>
            <Button
              variant={hoveringDelete ? "destructive" : "ghost"}
              size="icon"
              onClick={deleteLayers}
              onMouseEnter={() => setHoveringDelete(true)}
              onMouseLeave={() => setHoveringDelete(false)}
            >
              <Trash2 />
            </Button>
          </Hint>
        </div>
      </div>
    );
  }
);

SelectionTools.displayName = "SelectionTools";
