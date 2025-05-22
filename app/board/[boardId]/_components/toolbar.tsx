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

interface BoardToolbarProps {
  canvasState: BoardCanvasState;
  setCanvasState: (canvasState: BoardCanvasState) => void;
  undo: () => void;
  redo: () => void;
  canUndo: boolean;
  canRedo: boolean;
  selectedPenSize: number;
  onPenSizeChange: (size: number) => void;
}

export const BoardToolbar = ({
  canvasState,
  setCanvasState,
  undo,
  redo,
  canUndo,
  canRedo,
  onPenSizeChange,
  selectedPenSize
}: BoardToolbarProps) => {
  // состояние открытия менюшки пера
  const [penOpen, setPenOpen] = useState(false);

  return (
    <div className="absolute top-1/2 left-2 transform -translate-y-1/2 flex flex-col gap-4 z-10">
      {/* Основные инструменты */}
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

        {/* === Pen с контролем открытия === */}
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
                // переключаем режим в Pencil и открываем меню
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
            // чтобы клики внутри не сбрасывали canvasState
            onPointerDown={(e) => e.stopPropagation()}
            onPointerUp={(e) => e.stopPropagation()}
          >
            <PenSizePicker
              currentSize={selectedPenSize}
              onChange={(size) => {
                onPenSizeChange(size);
                // после выбора — закрываем меню
                setPenOpen(false);
                // и остаёмся в Pencil-режиме
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
      </div>

      {/* Undo / Redo */}
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
