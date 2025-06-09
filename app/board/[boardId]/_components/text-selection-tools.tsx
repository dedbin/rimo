"use client";

import { useState, useEffect, memo } from "react";
import { useActiveSelectionArea } from "@/hooks/use-selection-bounds";
import { Camera, Color, LayerType } from "@/types/board-canvas";
import { useMutation, useSelf, useStorage } from "@liveblocks/react/suspense";
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
    const selection = useSelf((me) => me.presence.selection ?? []);
    const { t } = useTranslation();
    const bounds = useActiveSelectionArea();
    const deleteLayers = useDeleteLayers();

    const moveToBack = useMutation(({ storage }) => {
      const liveLayerIds = storage.get("layerIds");
      const arr = liveLayerIds.toImmutable();
      const indices = arr
        .map((id, idx) => ({ id, idx }))
        .filter((item) => selection.includes(item.id))
        .map((item) => item.idx)
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
        .filter((item) => selection.includes(item.id))
        .map((item) => item.idx)
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

    const setFontSize = useMutation(({ storage }, size: number) => {
        const liveLayers = storage.get("layers");
        const id = selection[0];
        // @ts-ignore
        liveLayers.get(id)?.set("fontSize", size);
    }, [selection]);

    const currentFontSize = useStorage((root) => {
        const id = selection[0];
        // @ts-ignore
        return root.layers.get(id)?.fontSize ?? 24;
    });

    const setFontFamily = useMutation(({ storage }, font: string) => {
        const liveLayers = storage.get("layers");
        const id = selection[0];
        // @ts-ignore
        liveLayers.get(id)?.set("fontFamily", font);
    }, [selection]);

    const currentFontFamily = useStorage((root) => {
        const id = selection[0];
        // @ts-ignore
        return root.layers.get(id)?.fontFamily ?? "Noto Sans";
    });

    const currentFill = useStorage((root) => {
        const id = selection[0];
        return root.layers.get(id)?.fill ?? { r: 0, g: 0, b: 0 };
    });

    const [hoveringDelete, setHoveringDelete] = useState(false);

    useEffect(() => {
      setHoveringDelete(false);
    }, [selection]);

    if (!bounds || selection.length === 0) {
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