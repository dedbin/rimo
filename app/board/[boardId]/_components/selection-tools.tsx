"use client";

import { useState, useEffect, memo } from "react";
import { useActiveSelectionArea } from "@/hooks/use-selection-bounds";
import { Camera, Color } from "@/types/board-canvas";
import { useBoardRuntime, useSelection } from "@/lib/collaboration/react";
import { ColorPicker } from "./color-picker";
import { useDeleteLayers } from "@/hooks/use-delete-layers";
import { Button } from "@/components/ui/button";
import { Hint } from "@/components/hint";
import { BringToFront, SendToBack, Trash2 } from "lucide-react";
import { useTranslation } from "@/hooks/use-translation";

interface SelectionToolsProps {
  camera: Camera;
  setLastUsedColor: (color: Color) => void;
}

export const SelectionTools = memo(
  ({ camera, setLastUsedColor }: SelectionToolsProps) => {
    const runtime = useBoardRuntime();
    const selection = useSelection();
    const { t } = useTranslation();
    const bounds = useActiveSelectionArea();
    const deleteLayers = useDeleteLayers();

    const moveToBack = () => runtime.board.reorder(selection, "back");
    const moveToFront = () => runtime.board.reorder(selection, "front");
    const setFill = (fill: Color) => {
      setLastUsedColor(fill);
      runtime.board.update(selection, { fill });
    };

    const [hoveringDelete, setHoveringDelete] = useState(false);

    useEffect(() => {
      setHoveringDelete(false);
    }, [selection]);

    if (!bounds || selection.length === 0 || !runtime.board.canEdit) {
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
          <Hint label={t("selectionTools.bringToFront")}>
            <Button variant="ghost" size="icon" onClick={moveToFront}>
              <BringToFront />
            </Button>
          </Hint>
          <Hint label={t("selectionTools.sendToBack")} side="bottom">
            <Button variant="ghost" size="icon" onClick={moveToBack}>
              <SendToBack />
            </Button>
          </Hint>
        </div>
        <div className="flex items-center pl-2 ml-2 border-l border-neutral-200">
          <Hint label={t("selectionTools.delete")} side="right" sideOffset={10}>
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
