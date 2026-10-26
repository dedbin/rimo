"use client";

import { useState, useEffect, memo } from "react";
import { useActiveSelectionArea } from "@/hooks/use-selection-bounds";
import { Camera, Color, LayerType } from "@/types/board-canvas";
import { useBoardRuntime, useLayer, useSelection } from "@/lib/collaboration/react";
import { ColorDropdown } from "./color-dropdown";
import { useDeleteLayers } from "@/hooks/use-delete-layers";
import { Button } from "@/components/ui/button";
import { Hint } from "@/components/hint";
import { BringToFront, SendToBack, Trash2 } from "lucide-react";
import { FontSizePicker } from "./font-size-picker";
import { FontFamilyPicker } from "./font-family-picker";
import { useTranslation } from "@/hooks/use-translation";



interface TextSelectionToolsProps {
  camera: Camera;
  setLastUsedColor: (color: Color) => void;
}

export const TextSelectionTools = memo(
  ({ camera, setLastUsedColor }: TextSelectionToolsProps) => {
    const runtime = useBoardRuntime();
    const selection = useSelection();
    const layer = useLayer(selection[0] ?? "");
    const { t } = useTranslation();
    const bounds = useActiveSelectionArea();
    const deleteLayers = useDeleteLayers();

    const moveToBack = () => runtime.board.reorder(selection, "back");
    const moveToFront = () => runtime.board.reorder(selection, "front");
    const setFill = (fill: Color) => { setLastUsedColor(fill); runtime.board.update(selection, { fill }); };
    const setFontSize = (fontSize: number) => runtime.board.update(selection, { fontSize });
    const setFontFamily = (fontFamily: string) => runtime.board.update(selection, { fontFamily });
    const isText = layer?.type === LayerType.Text || layer?.type === LayerType.Sticker;
    const currentFontSize = isText ? layer.fontSize : 16;
    const currentFontFamily = isText ? layer.fontFamily ?? "Noto Sans" : "Noto Sans";
    const currentFill = layer?.fill ?? { r: 0, g: 0, b: 0 };

    const [hoveringDelete, setHoveringDelete] = useState(false);

    useEffect(() => {
      setHoveringDelete(false);
    }, [selection]);

    if (!bounds || selection.length === 0 || !runtime.board.canEdit) {
      return null;
    }

    const x = bounds.x * camera.scale + (bounds.width * camera.scale) / 2 + camera.x;
    const y = bounds.y * camera.scale + camera.y;

    return (
      <div
        className="absolute px-3 py-2 rounded-xl bg-white shadow-sm border flex items-center select-none gap-2"
        style={{
            transform: `translate(calc(${x}px - 50%), calc(${y - 10 * camera.scale}px - 100%))`,
        }}
    >
        
        <ColorDropdown currentColor={currentFill} onChange={setFill} />

        <FontFamilyPicker
            currentFont={currentFontFamily}
            onChange={setFontFamily}
        />
        <FontSizePicker 
            currentSize={currentFontSize} 
            onChange={setFontSize} 
        />
        
        <div className="flex items-center gap-1 ml-2 pl-2 border-l border-neutral-200">
            <Hint label={t("selectionTools.bringToFront")}>
            <Button variant="ghost" size="icon" onClick={moveToFront}>
                <BringToFront />
            </Button>
            </Hint>
            <Hint label={t("selectionTools.sendToBack")}>
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

TextSelectionTools.displayName = "TextSelectionTools";
