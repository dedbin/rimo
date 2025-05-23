"use client";

import {
  Circle,
  MousePointer2,
  Pencil,
  Redo2,
  Square,
  StickyNote,
  Type,
  Undo2,
  Image as ImageIcon
} from "lucide-react";

import { ToolButton } from "./tool-button";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
} from "@/components/ui/dropdown-menu";
import { PenSizePicker } from "./pen-size-picker";
import { BoardCanvasMode, BoardCanvasState, LayerType } from "@/types/board-canvas";
import { useState } from "react";
import { ImageUpload } from "./image-upload"; 

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
}: BoardToolbarProps) => {
  const [penOpen, setPenOpen] = useState(false);

  return (
    <div className="absolute top-1/2 left-2 transform -translate-y-1/2 flex flex-col gap-4 z-10">
      <div className="bg-white rounded-md shadow-md p-1.5 flex flex-col gap-y-1 items-center">
        <ToolButton
          label="select"
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
          label="text (Ctrl+T)"
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
          label="stickers (Ctrl+S)"
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
          label="rectangle (Ctrl+R)"
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
          label="ellipse (Ctrl+O)"
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
  label="image"
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
        alert("Image upload failed.");
      }
    };

    input.click();
  }}
/>
      </div>

      <div className="bg-white rounded-md shadow-md p-1.5 flex flex-col items-center">
        <ToolButton
          label="undo (Ctrl+Z)"
          icon={Undo2}
          onClick={undo}
          isDisabled={!canUndo}
        />
        <ToolButton
          label="redo (Ctrl+Y)"
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
        {[...Array(4)].map((_, i) => (
          <div
            key={`tool-skel-${i}`}
            className="h-8 w-8 bg-muted animate-pulse rounded"
          />
        ))}
      </div>
      <div className="bg-white rounded-md shadow-md p-1.5 flex flex-col gap-y-2 items-center">
        {[...Array(2)].map((_, i) => (
          <div
            key={`action-skel-${i}`}
            className="h-8 w-8 bg-muted animate-pulse rounded"
          />
        ))}
      </div>
    </div>
  );
};
