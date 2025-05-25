"use client";

import { useState } from "react";
import {
  Circle,
  MousePointer2,
  Pencil,
  Redo2,
  Square,
  StickyNote,
  Type,
  Undo2,
  Image as ImageIcon,
  ZoomIn, 
  ZoomOut
} from "lucide-react";
import { ToolButton } from "./tool-button";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
} from "@/components/ui/dropdown-menu";
import { PenSizePicker } from "./pen-size-picker";
import {
  BoardCanvasMode,
  BoardCanvasState,
  Camera,
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
  onPenSizeChange: (size: number) => void;
  onImageUpload: (url: string) => void;
  setCamera: React.Dispatch<React.SetStateAction<Camera>>;
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
  onImageUpload,
  setCamera
}: BoardToolbarProps) => {
  const [penOpen, setPenOpen] = useState(false);
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

        <DropdownMenu open={penOpen} onOpenChange={setPenOpen}>
          <DropdownMenuTrigger asChild>
            <Button
              variant={
                canvasState.mode === BoardCanvasMode.Pencil
                  ? "boardActive"
                  : "board"
              }
              size="icon"
              onClick={() => {
                setCanvasState({ mode: BoardCanvasMode.Pencil });
                setPenOpen(true);
              }}
            >
              <Pencil />
            </Button>
          </DropdownMenuTrigger>

          <DropdownMenuContent
            side="right"
            align="center"
            sideOffset={8}
            className="bg-white p-2 shadow rounded-md"
            onPointerDown={(e) => e.stopPropagation()}
            onPointerUp={(e) => e.stopPropagation()}
          >
            <PenSizePicker
              currentSize={selectedPenSize}
              onChange={(size) => {
                onPenSizeChange(size);
                setPenOpen(false);
                setCanvasState({ mode: BoardCanvasMode.Pencil });
              }}
            />
          </DropdownMenuContent>
        </DropdownMenu>

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

              const formData = new FormData();
              formData.append("file", file);

              try {
                const response = await fetch("/api/upload-image", {
                  method: "POST",
                  body: formData,
                });

                if (!response.ok) {
                  throw new Error("Upload failed");
                }

                const data = await response.json();
                onImageUpload(data.url);
              } catch (err) {
                console.error("Upload error:", err);
                alert(t("toolbar.imageUploadError"));
              }
            };

            input.click();
          }}
        />
      </div>

      <div className="bg-white rounded-md shadow-md p-1.5 flex flex-col items-center">
        <ToolButton
          label={`${t("toolbar.zoomIn")}`}
          icon={ZoomIn}
          onClick={() =>
            setCamera((prev) => {
              const scale = Math.min(prev.scale * 1.1, 4);
              return {
                ...prev,
                scale,
                x: prev.x - ((window.innerWidth / 2 - prev.x) * (scale / prev.scale - 1)),
                y: prev.y - ((window.innerHeight / 2 - prev.y) * (scale / prev.scale - 1)),
              };
            })
          }
        />
        <ToolButton
          label={`${t("toolbar.zoomOut")}`}
          icon={ZoomOut}
          onClick={() =>
            setCamera((prev) => {
              const scale = Math.max(prev.scale * 0.9, 0.1);
              return {
                ...prev,
                scale,
                x: prev.x - ((window.innerWidth / 2 - prev.x) * (scale / prev.scale - 1)),
                y: prev.y - ((window.innerHeight / 2 - prev.y) * (scale / prev.scale - 1)),
              };
            })
          }
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
