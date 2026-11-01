"use client";

import { useState } from "react";
import { Check, MoveHorizontal, Slash } from "lucide-react";

import { buttonVariants } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { useTranslation } from "@/hooks/use-translation";
import { BoardCanvasMode, LayerType } from "@/types/board-canvas";
import type { BoardCanvasState, LineKind, LineStrokeStyle } from "@/types/board-canvas";

interface LineToolProps {
  canvasState: BoardCanvasState;
  setCanvasState: (state: BoardCanvasState) => void;
}

export function LineTool({ canvasState, setCanvasState }: LineToolProps) {
  const { t } = useTranslation();
  const [remembered, setRemembered] = useState<{ lineKind: LineKind; strokeStyle: LineStrokeStyle }>({ lineKind: "segment", strokeStyle: "solid" });
  const active = canvasState.mode === BoardCanvasMode.Inserting && canvasState.layerType === LayerType.Line;
  const kinds: readonly LineKind[] = ["segment", "line"];
  const styles: readonly LineStrokeStyle[] = ["solid", "dashed"];
  const lineKind = active ? canvasState.lineKind ?? "segment" : remembered.lineKind;
  const strokeStyle = active ? canvasState.strokeStyle ?? "solid" : remembered.strokeStyle;
  const activate = (kind: LineKind, style: LineStrokeStyle) => {
    setRemembered({ lineKind: kind, strokeStyle: style });
    setCanvasState({ mode: BoardCanvasMode.Inserting, layerType: LayerType.Line, lineKind: kind, strokeStyle: style });
  };

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
      <DropdownMenuGroup aria-label={t("lineTools.type")}>
      {kinds.map((kind) => <DropdownMenuItem key={kind} role="menuitemradio"
        aria-checked={lineKind === kind}
        onSelect={() => activate(kind, strokeStyle)}
        className="min-h-11 cursor-pointer rounded-md px-2 focus:bg-emerald-50">
        {kind === "segment" ? <Slash aria-hidden="true" /> : <MoveHorizontal aria-hidden="true" />}
        <span className="flex-1">{t(`lineTools.${kind}`)}</span>
        {lineKind === kind && <Check aria-hidden="true" className="text-emerald-600" />}
      </DropdownMenuItem>)}
      </DropdownMenuGroup>
      <DropdownMenuLabel className="px-2 pb-1 pt-3 text-xs font-medium text-neutral-500">{t("lineTools.strokeStyle")}</DropdownMenuLabel>
      <DropdownMenuGroup aria-label={t("lineTools.strokeStyle")}>
        {styles.map((style) => <DropdownMenuItem key={style} role="menuitemradio" aria-label={t(`lineTools.${style}`)}
          aria-checked={strokeStyle === style}
          onSelect={(event) => { event.preventDefault(); activate(lineKind, style); }}
          className="min-h-11 cursor-pointer rounded-md px-2 focus:bg-emerald-50">
          <svg aria-hidden="true" className="h-5 w-9" viewBox="0 0 36 20">
            <line x1="2" y1="10" x2="34" y2="10" stroke="currentColor" strokeWidth="2"
              strokeLinecap="round" strokeDasharray={style === "dashed" ? "8 6" : undefined} />
          </svg>
          <span className="flex-1">{t(`lineTools.${style}`)}</span>
          {strokeStyle === style && <Check aria-hidden="true" className="text-emerald-600" />}
        </DropdownMenuItem>)}
      </DropdownMenuGroup>
    </DropdownMenuContent>
  </DropdownMenu>;
}
