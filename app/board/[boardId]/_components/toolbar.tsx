"use client";

import {
  Circle,
  MousePointer2,
  Redo2,
  Square,
  StickyNote,
  Type,
  Undo2,
  Image as ImageIcon,
  ZoomIn, 
  ZoomOut,
  EraserIcon
} from "lucide-react";
import { ToolButton } from "./tool-button";
import { PenTool } from "./pen-tool";
import { LineTool } from "./line-tool";
import {
  BoardCanvasMode,
  BoardCanvasState,
  Camera,
  Color,
  LayerType
} from "@/types/board-canvas";
import { useTranslation } from "@/hooks/use-translation";

interface BoardToolbarProps {
  canvasState: BoardCanvasState;
  setCanvasState: (canvasState: BoardCanvasState) => void;
  undo: () => void;
  redo: () => void;
  canUndo: boolean;
  canRedo: boolean;
  selectedPenSize: number;
  selectedPenColor: Color;
  onPenColorChange: (color: Color) => void;
  onPenSizeChange: (size: number) => void;
  onImageUpload: (file: File) => Promise<void>;
  camera: Camera;
  animateCameraTo: (camera: Camera) => void;
}

export const BoardToolbar = ({
  canvasState,
  setCanvasState,
  undo,
  redo,
  canUndo,
  canRedo,
  onPenSizeChange,
  selectedPenSize,
  selectedPenColor,
  onPenColorChange,
  onImageUpload,
  camera,
  animateCameraTo
}: BoardToolbarProps) => {
  const { t } = useTranslation();

  return (
    <div className="absolute top-1/2 left-2 transform -translate-y-1/2 flex flex-col gap-4 z-10">
      <div className="bg-white rounded-md shadow-md p-1.5 flex flex-col gap-y-1 items-center">
        <ToolButton
          label={t("toolbar.select")}
          icon={MousePointer2}
          onClick={() => setCanvasState({ mode: BoardCanvasMode.None })}
          isActive={
            [
              BoardCanvasMode.None,
              BoardCanvasMode.Translating,
              BoardCanvasMode.SelectionNet,
              BoardCanvasMode.Pressing,
              BoardCanvasMode.Resizing,
              BoardCanvasMode.Panning
            ].includes(canvasState.mode)
          }
        />

        <ToolButton
          label={`${t("toolbar.text")} (Ctrl+T)`}
          icon={Type}
          onClick={() =>
            setCanvasState({
              mode: BoardCanvasMode.Inserting,
              layerType: LayerType.Text,
            })
          }
          isActive={
            canvasState.mode === BoardCanvasMode.Inserting &&
            canvasState.layerType === LayerType.Text
          }
        />

        <PenTool active={canvasState.mode === BoardCanvasMode.Pencil} color={selectedPenColor} size={selectedPenSize}
          onActivate={() => setCanvasState({ mode: BoardCanvasMode.Pencil })}
          onColorChange={onPenColorChange} onSizeChange={onPenSizeChange} />

        <ToolButton
          label={`${t("toolbar.eraser")} (Ctrl+E)`}
          icon={EraserIcon}
          isActive={canvasState.mode === BoardCanvasMode.Eraser}
          onClick={() =>
            setCanvasState({
              mode: BoardCanvasMode.Eraser,
            })
          }
        />

        <ToolButton
          label={`${t("toolbar.stickers")} (Ctrl+S)`}
          icon={StickyNote}
          onClick={() =>
            setCanvasState({
              mode: BoardCanvasMode.Inserting,
              layerType: LayerType.Sticker,
            })
          }
          isActive={
            canvasState.mode === BoardCanvasMode.Inserting &&
            canvasState.layerType === LayerType.Sticker
          }
        />

        <ToolButton
          label={`${t("toolbar.rectangle")} (Ctrl+R)`}
          icon={Square}
          onClick={() =>
            setCanvasState({
              mode: BoardCanvasMode.Inserting,
              layerType: LayerType.Rectangle,
            })
          }
          isActive={
            canvasState.mode === BoardCanvasMode.Inserting &&
            canvasState.layerType === LayerType.Rectangle
          }
        />

        <ToolButton
          label={`${t("toolbar.ellipse")} (Ctrl+O)`}
          icon={Circle}
          onClick={() =>
            setCanvasState({
              mode: BoardCanvasMode.Inserting,
              layerType: LayerType.Ellipse,
            })
          }
          isActive={
            canvasState.mode === BoardCanvasMode.Inserting &&
            canvasState.layerType === LayerType.Ellipse
          }
        />

        <LineTool canvasState={canvasState} setCanvasState={setCanvasState} />

        <ToolButton
          label={t("toolbar.image")}
          icon={ImageIcon}
          onClick={() => {
            const input = document.createElement("input");
            input.type = "file";
            input.accept = "image/*";

            input.onchange = async () => {
              const file = input.files?.[0];
              if (!file) return;

              await onImageUpload(file);
            };

            input.click();
          }}
        />
      </div>

      <div className="bg-white rounded-md shadow-md p-1.5 flex flex-col items-center">
        <ToolButton
          label={`${t("toolbar.zoomIn")}`}
          icon={ZoomIn}
          onClick={() => {
            const scale = Math.min(camera.scale * 1.1, 4);
            animateCameraTo({
              ...camera,
              scale,
              x: camera.x - ((window.innerWidth / 2 - camera.x) * (scale / camera.scale - 1)),
              y: camera.y - ((window.innerHeight / 2 - camera.y) * (scale / camera.scale - 1)),
            });
          }}
        />
        <ToolButton
          label={`${t("toolbar.zoomOut")}`}
          icon={ZoomOut}
          onClick={() => {
            const scale = Math.max(camera.scale * 0.9, 0.1);
            animateCameraTo({
              ...camera,
              scale,
              x: camera.x - ((window.innerWidth / 2 - camera.x) * (scale / camera.scale - 1)),
              y: camera.y - ((window.innerHeight / 2 - camera.y) * (scale / camera.scale - 1)),
            });
          }}
        />
        <ToolButton
          label={`${t("toolbar.undo")} (Ctrl+Z)`}
          icon={Undo2}
          onClick={undo}
          isDisabled={!canUndo}
        />
        <ToolButton
          label={`${t("toolbar.redo")} (Ctrl+Y)`}
          icon={Redo2}
          onClick={redo}
          isDisabled={!canRedo}
        />
      </div>
    </div>
  );
};

export const BoardToolbarSkeleton = () => {
  return (
    <div className="absolute top-1/2 left-2 transform -translate-y-1/2 flex flex-col gap-4">
      <div className="bg-white rounded-md shadow-md p-1.5 flex flex-col gap-y-2 items-center">
        {[...Array(6)].map((_, i) => (
          <div
            key={`tool-skel-${i}`}
            className="h-8 w-8 bg-muted animate-pulse rounded"
          />
        ))}
      </div>
      <div className="bg-white rounded-md shadow-md p-1.5 flex flex-col gap-y-2 items-center">
        {[...Array(4)].map((_, i) => (
          <div
            key={`action-skel-${i}`}
            className="h-8 w-8 bg-muted animate-pulse rounded"
          />
        ))}
      </div>
    </div>
  );
};
