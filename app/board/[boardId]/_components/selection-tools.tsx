"use client";

import { useState, useEffect, memo } from "react";
import { useActiveSelectionArea } from "@/hooks/use-selection-bounds";
import { Camera, Color, LayerType } from "@/types/board-canvas";
import { useBoardRuntime, useBoardSnapshot, useSelection } from "@/lib/collaboration/react";
import { isShape } from "@/lib/board/shape-style";
import { ColorPicker } from "./color-picker";
import { ShapeColorControls } from "./shape-color-controls";
import { LineStyleControls } from "./line-style-controls";
import { PaintPicker } from "./paint-picker";
import { samePaint } from "@/lib/board/shape-style";
import { useSelectionToolbarPosition } from "../_hooks/use-selection-toolbar-position";
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
    const snapshot = useBoardSnapshot();
    const selection = useSelection();
    const { t } = useTranslation();
    const bounds = useActiveSelectionArea();
    const { ref, position } = useSelectionToolbarPosition(bounds, camera);
    const deleteLayers = useDeleteLayers();
    const hasShapes = selection.some((id) => isShape(snapshot.layers.get(id)));
    const hasLines = selection.some((id) => snapshot.layers.get(id)?.type === LayerType.Line);
    const colorIds = selection.filter((id) => {
      const layer = snapshot.layers.get(id);
      return layer?.type === LayerType.Text || layer?.type === LayerType.Sticker || layer?.type === LayerType.Path;
    });
    const colors = colorIds.map((id) => snapshot.layers.get(id)!.fill!);

    const moveToBack = () => runtime.board.reorder(selection, "back");
    const moveToFront = () => runtime.board.reorder(selection, "front");
    const setFill = (fill: Color) => {
      setLastUsedColor(fill);
      runtime.board.update(colorIds, { fill });
    };

    const [hoveringDelete, setHoveringDelete] = useState(false);

    useEffect(() => {
      setHoveringDelete(false);
    }, [selection]);

    if (!bounds || selection.length === 0 || !runtime.board.canEdit) {
      return null;
    }

    return (
      <div
        ref={ref}
        role="toolbar"
        aria-label={t("selectionTools.objectStyle")}
        className="absolute z-10 w-max max-w-[calc(100vw-16px)] rounded-xl border border-neutral-200 bg-white p-1.5 shadow-md flex flex-wrap items-center select-none"
        style={position}
      >
        {hasShapes && <ShapeColorControls setLastUsedColor={setLastUsedColor} />}
        {hasLines && <LineStyleControls setLastUsedColor={setLastUsedColor} />}
        {colors.length > 0 && (hasShapes || hasLines
          ? <PaintPicker label={t("selectionTools.color")} value={colors[0]} mixed={colors.some((color) => !samePaint(color, colors[0]))}
              onChange={(color) => { if (color) setFill(color); }} />
          : <ColorPicker onChange={setFill} />)}
        <div className="ml-1 flex items-center border-l border-neutral-200 pl-1">
          <Hint label={t("selectionTools.bringToFront")}>
            <Button variant="ghost" size="icon" aria-label={t("selectionTools.bringToFront")} onClick={moveToFront}>
              <BringToFront />
            </Button>
          </Hint>
          <Hint label={t("selectionTools.sendToBack")} side="bottom">
            <Button variant="ghost" size="icon" aria-label={t("selectionTools.sendToBack")} onClick={moveToBack}>
              <SendToBack />
            </Button>
          </Hint>
        </div>
        <div className="flex items-center pl-2 ml-2 border-l border-neutral-200">
          <Hint label={t("selectionTools.delete")} side="right" sideOffset={10}>
            <Button
              variant={hoveringDelete ? "destructive" : "ghost"}
              size="icon"
              aria-label={t("selectionTools.delete")}
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
