"use client";

import { useRef } from "react";
import { Check, ChevronDown, Minus, Slash } from "lucide-react";
import { buttonVariants } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { useTranslation } from "@/hooks/use-translation";
import { getContrastingTextColor, rgbToCss } from "@/lib/board/colors";
import { samePaint } from "@/lib/board/shape-style";
import type { Paint } from "@/lib/board/shape-style";
import type { Color } from "@/types/board-canvas";

const COLORS: readonly { name: string; color: Color }[] = [
  { name: "black", color: { r: 0, g: 0, b: 0 } },
  { name: "white", color: { r: 255, g: 255, b: 255 } },
  { name: "emerald", color: { r: 52, g: 211, b: 153 } },
  { name: "blue", color: { r: 59, g: 130, b: 246 } },
  { name: "purple", color: { r: 168, g: 85, b: 247 } },
  { name: "red", color: { r: 239, g: 68, b: 68 } },
  { name: "yellow", color: { r: 234, g: 179, b: 8 } },
  { name: "orange", color: { r: 249, g: 115, b: 22 } },
];

interface PaintPickerProps {
  label: string;
  value: Paint;
  mixed: boolean;
  onChange: (color: Paint) => void;
  emptyLabel?: string;
  outline?: boolean;
}

export function PaintPicker({ label, value, mixed, onChange, emptyLabel, outline = false }: PaintPickerProps) {
  const { t } = useTranslation();
  const trigger = useRef<HTMLButtonElement>(null);
  const status = mixed ? t("selectionTools.mixed") : value
    ? t(`selectionTools.colors.${COLORS.find(({ color }) => samePaint(color, value))?.name ?? "custom"}`)
    : emptyLabel ?? t("selectionTools.noOutline");

  return <DropdownMenu modal={false}>
    <DropdownMenuTrigger asChild>
      <button ref={trigger} type="button" className={buttonVariants({ variant: "ghost", className: "h-10 gap-2 px-2.5 text-neutral-700" })} aria-label={`${label}: ${status}`}>
        <span aria-hidden="true" className="relative flex size-5 shrink-0 items-center justify-center rounded-sm border border-neutral-300 bg-white"
          style={!mixed && value ? outline ? { borderColor: rgbToCss(value), borderWidth: 2 } : { background: rgbToCss(value) } : undefined}>
          {mixed ? <Minus className="size-3 text-neutral-500" /> : !value && <Slash className="size-4 text-red-500" />}
        </span>
        <span className="text-sm font-medium max-[420px]:sr-only">{label}</span>
        <ChevronDown aria-hidden="true" className="size-3 text-neutral-400" />
      </button>
    </DropdownMenuTrigger>
    <DropdownMenuContent align="start" sideOffset={8} collisionPadding={12} className="w-[220px] rounded-xl border-neutral-200 bg-white p-2 shadow-lg data-[state=closed]:animate-none data-[state=closed]:hidden"
      aria-label={label} onKeyDown={(event) => event.stopPropagation()}
      onEscapeKeyDown={(event) => event.stopPropagation()}
      onInteractOutside={(event) => { if (event.target instanceof Node && trigger.current?.contains(event.target)) event.preventDefault(); }}>
      <DropdownMenuLabel className="px-2 pb-2 pt-1 text-xs font-medium text-neutral-500">{label}</DropdownMenuLabel>
      {emptyLabel && <DropdownMenuItem role="menuitemradio" aria-checked={!mixed && value === null}
        onSelect={() => onChange(null)} className="mb-2 h-10 cursor-pointer gap-2 rounded-md border border-neutral-200 px-2 focus:bg-emerald-50">
        <span aria-hidden="true" className="flex size-6 items-center justify-center rounded-sm border border-neutral-200 bg-white"><Slash className="size-4 text-red-500" /></span>
        <span className="flex-1 text-sm">{emptyLabel}</span>
        {!mixed && value === null && <Check aria-hidden="true" className="size-4 text-emerald-600" />}
      </DropdownMenuItem>}
      <div className="grid grid-cols-4 gap-2 p-1">
        {COLORS.map(({ name, color }) => <DropdownMenuItem key={name} role="menuitemradio"
          aria-label={`${label}: ${t(`selectionTools.colors.${name}`)}`} aria-checked={!mixed && samePaint(color, value)}
          onSelect={() => onChange(color)} title={t(`selectionTools.colors.${name}`)}
          className="flex size-10 cursor-pointer items-center justify-center rounded-md border border-black/15 p-0 outline-offset-2 transition-transform focus:scale-110 focus:ring-2 focus:ring-emerald-500"
          style={{ background: rgbToCss(color), color: getContrastingTextColor(color) }}>
          {!mixed && samePaint(color, value) && <Check aria-hidden="true" className="size-5 text-inherit" />}
        </DropdownMenuItem>)}
      </div>
    </DropdownMenuContent>
  </DropdownMenu>;
}
