"use client";

import { useRef } from "react";
import { ArrowLeft, ArrowRight, Check, ChevronDown } from "lucide-react";

import { buttonVariants } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { useTranslation } from "@/hooks/use-translation";
import { samePaint } from "@/lib/board/shape-style";
import { useBoardRuntime, useBoardSnapshot, useSelection } from "@/lib/collaboration/react";
import { LayerType } from "@/types/board-canvas";
import type { Color, LineKind, LineLayer } from "@/types/board-canvas";

import { PaintPicker } from "./paint-picker";

const WIDTHS = [1, 2, 4, 6, 8] as const;
const KINDS: readonly LineKind[] = ["segment", "line"];

export function LineStyleControls({ setLastUsedColor }: { setLastUsedColor: (color: Color) => void }) {
  const runtime = useBoardRuntime();
  const snapshot = useBoardSnapshot();
  const selection = useSelection();
  const { t } = useTranslation();
  const widthTrigger = useRef<HTMLButtonElement>(null);
  const kindTrigger = useRef<HTMLButtonElement>(null);
  const lineIds = selection.filter((id) => snapshot.layers.get(id)?.type === LayerType.Line);
  const lines = lineIds.map((id) => snapshot.layers.get(id) as LineLayer);
  if (!lines.length) return null;
  const segments = lines.filter((layer) => layer.lineKind === "segment");
  const segmentIds = lineIds.filter((id) => snapshot.layers.get(id)?.type === LayerType.Line &&
    (snapshot.layers.get(id) as LineLayer).lineKind === "segment");
  const first = lines[0];
  const widthsMixed = lines.some((layer) => layer.strokeWidth !== first.strokeWidth);
  const kindsMixed = lines.some((layer) => layer.lineKind !== first.lineKind);
  const widthLabel = `${t("lineTools.thickness")}: ${widthsMixed ? t("lineTools.mixed") : t("lineTools.widthValue", { width: first.strokeWidth })}`;
  const kindLabel = `${t("lineTools.type")}: ${kindsMixed ? t("lineTools.mixed") : t(`lineTools.${first.lineKind}`)}`;

  return <div className="flex max-w-full flex-wrap items-center gap-1">
    <PaintPicker label={t("lineTools.color")} value={first.fill}
      mixed={lines.some((layer) => !samePaint(layer.fill, first.fill))}
      onChange={(fill) => {
        if (!fill) return;
        setLastUsedColor(fill);
        runtime.board.update(lineIds, { fill });
      }} />
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <button ref={widthTrigger} type="button" title={widthLabel} aria-label={widthLabel}
          className={buttonVariants({ variant: "ghost", className: "h-10 gap-1.5 px-2.5 text-neutral-700" })}>
          <svg aria-hidden="true" className="size-5" viewBox="0 0 20 20">
            <line x1="2" y1="10" x2="18" y2="10" stroke="currentColor" strokeWidth={widthsMixed ? 2 : first.strokeWidth} strokeLinecap="round" />
          </svg>
          <span className="min-w-2 text-xs tabular-nums">{widthsMixed ? "—" : first.strokeWidth}</span>
          <ChevronDown aria-hidden="true" className="size-3 text-neutral-400" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" sideOffset={8} collisionPadding={12} aria-label={t("lineTools.thickness")}
        className="w-44 rounded-xl border-neutral-200 bg-white p-2 shadow-lg data-[state=closed]:animate-none data-[state=closed]:hidden"
        onKeyDown={(event) => event.stopPropagation()} onEscapeKeyDown={(event) => event.stopPropagation()}
        onInteractOutside={(event) => { if (event.target instanceof Node && widthTrigger.current?.contains(event.target)) event.preventDefault(); }}>
        <DropdownMenuLabel className="text-xs font-medium text-neutral-500">{t("lineTools.thickness")}</DropdownMenuLabel>
        {WIDTHS.map((width) => <DropdownMenuItem key={width} role="menuitemradio"
          aria-checked={!widthsMixed && first.strokeWidth === width} aria-label={t("lineTools.widthValue", { width })}
          onSelect={() => runtime.board.update(lineIds, { strokeWidth: width })}
          className="min-h-10 cursor-pointer rounded-md focus:bg-emerald-50">
          <svg aria-hidden="true" className="h-5 w-12" viewBox="0 0 48 20">
            <line x1="4" y1="10" x2="44" y2="10" stroke="currentColor" strokeWidth={width} strokeLinecap="round" />
          </svg>
          <span className="flex-1">{t("lineTools.widthValue", { width })}</span>
          {!widthsMixed && first.strokeWidth === width && <Check aria-hidden="true" className="text-emerald-600" />}
        </DropdownMenuItem>)}
      </DropdownMenuContent>
    </DropdownMenu>
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <button ref={kindTrigger} type="button" title={kindLabel} aria-label={kindLabel}
          className={buttonVariants({ variant: "ghost", className: "h-10 gap-1.5 px-2.5 text-neutral-700" })}>
          <span className="text-sm">{kindsMixed ? t("lineTools.type") : t(`lineTools.${first.lineKind}`)}</span>
          <ChevronDown aria-hidden="true" className="size-3 text-neutral-400" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" sideOffset={8} collisionPadding={12} aria-label={t("lineTools.type")}
        className="w-44 rounded-xl border-neutral-200 bg-white p-2 shadow-lg data-[state=closed]:animate-none data-[state=closed]:hidden"
        onKeyDown={(event) => event.stopPropagation()} onEscapeKeyDown={(event) => event.stopPropagation()}
        onInteractOutside={(event) => { if (event.target instanceof Node && kindTrigger.current?.contains(event.target)) event.preventDefault(); }}>
        <DropdownMenuLabel className="text-xs font-medium text-neutral-500">{t("lineTools.type")}</DropdownMenuLabel>
        {KINDS.map((kind) => <DropdownMenuItem key={kind} role="menuitemradio"
          aria-checked={!kindsMixed && first.lineKind === kind}
          onSelect={() => runtime.board.update(lineIds, { lineKind: kind })}
          className="min-h-10 cursor-pointer rounded-md focus:bg-emerald-50">
          <span className="flex-1">{t(`lineTools.${kind}`)}</span>
          {!kindsMixed && first.lineKind === kind && <Check aria-hidden="true" className="text-emerald-600" />}
        </DropdownMenuItem>)}
      </DropdownMenuContent>
    </DropdownMenu>
    <div className="flex items-center border-l border-neutral-200 pl-1">
      {(["startArrow", "endArrow"] as const).map((property) => {
        const all = segments.length > 0 && segments.every((layer) => layer[property]);
        const mixed = !all && segments.some((layer) => layer[property]);
        const label = t(`lineTools.${property}`);
        return <button key={property} type="button" aria-label={label} aria-pressed={mixed ? "mixed" : all}
          title={segments.length ? label : t("lineTools.arrowsHint")} disabled={!segments.length}
          className={buttonVariants({ variant: all || mixed ? "boardActive" : "ghost", size: "icon", className: "size-10" })}
          onClick={() => runtime.board.update(segmentIds, { [property]: !all })}>
          {property === "startArrow" ? <ArrowLeft aria-hidden="true" /> : <ArrowRight aria-hidden="true" />}
        </button>;
      })}
    </div>
  </div>;
}
