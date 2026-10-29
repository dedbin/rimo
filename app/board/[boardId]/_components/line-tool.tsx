"use client";

import { Check, MoveHorizontal, Slash } from "lucide-react";

import { buttonVariants } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { useTranslation } from "@/hooks/use-translation";
import { BoardCanvasMode, LayerType } from "@/types/board-canvas";
import type { BoardCanvasState, LineKind } from "@/types/board-canvas";

interface LineToolProps {
  canvasState: BoardCanvasState;
  setCanvasState: (state: BoardCanvasState) => void;
}

export function LineTool({ canvasState, setCanvasState }: LineToolProps) {
  const { t } = useTranslation();
  const active = canvasState.mode === BoardCanvasMode.Inserting && canvasState.layerType === LayerType.Line;
  const kinds: readonly LineKind[] = ["segment", "line"];

  return <DropdownMenu modal={false}>
    <DropdownMenuTrigger asChild>
      <button type="button" title={t("lineTools.label")} aria-label={t("lineTools.label")}
        className={buttonVariants({ variant: active ? "boardActive" : "board", size: "icon" })}>
        <Slash aria-hidden="true" />
      </button>
    </DropdownMenuTrigger>
    <DropdownMenuContent side="right" align="center" sideOffset={8} collisionPadding={12}
      className="w-60 rounded-xl border-neutral-200 bg-white p-2 shadow-lg data-[state=closed]:animate-none data-[state=closed]:hidden"
      aria-label={t("lineTools.label")} onKeyDown={(event) => event.stopPropagation()}
      onEscapeKeyDown={(event) => event.stopPropagation()}>
      <DropdownMenuLabel className="px-2 text-xs font-medium text-neutral-500">{t("lineTools.label")}</DropdownMenuLabel>
      {kinds.map((kind) => <DropdownMenuItem key={kind} role="menuitemradio"
        aria-checked={active && (canvasState.lineKind ?? "segment") === kind}
        onSelect={() => setCanvasState({ mode: BoardCanvasMode.Inserting, layerType: LayerType.Line, lineKind: kind })}
        className="min-h-11 cursor-pointer rounded-md px-2 focus:bg-emerald-50">
        {kind === "segment" ? <Slash aria-hidden="true" /> : <MoveHorizontal aria-hidden="true" />}
        <span className="flex-1">{t(`lineTools.${kind}`)}</span>
        {active && (canvasState.lineKind ?? "segment") === kind && <Check aria-hidden="true" className="text-emerald-600" />}
      </DropdownMenuItem>)}
    </DropdownMenuContent>
  </DropdownMenu>;
}
