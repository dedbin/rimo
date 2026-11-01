"use client";

import { Check, Pencil } from "lucide-react";

import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { getContrastingTextColor, rgbToCss } from "@/lib/board/colors";
import type { Color } from "@/types/board-canvas";

import { PenSizePicker } from "./pen-size-picker";

const COLORS: readonly { readonly name: string; readonly color: Color }[] = [
  { name: "Чёрный", color: { r: 0, g: 0, b: 0 } },
  { name: "Белый", color: { r: 255, g: 255, b: 255 } },
  { name: "Зелёный", color: { r: 52, g: 211, b: 153 } },
  { name: "Синий", color: { r: 59, g: 130, b: 246 } },
  { name: "Фиолетовый", color: { r: 168, g: 85, b: 247 } },
  { name: "Красный", color: { r: 239, g: 68, b: 68 } },
  { name: "Жёлтый", color: { r: 234, g: 179, b: 8 } },
  { name: "Оранжевый", color: { r: 249, g: 115, b: 22 } },
];

interface PenToolProps {
  readonly active: boolean;
  readonly color: Color;
  readonly size: number;
  readonly onActivate: () => void;
  readonly onColorChange: (color: Color) => void;
  readonly onSizeChange: (size: number) => void;
}

export function PenTool({ active, color, size, onActivate, onColorChange, onSizeChange }: PenToolProps) {
  return <div className="flex flex-col items-center gap-y-1">
    <Button type="button" variant={active ? "boardActive" : "board"} size="icon"
      aria-label="Маркер" aria-pressed={active} title="Маркер" onClick={onActivate}>
      <Pencil aria-hidden="true" />
    </Button>
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <Button type="button" variant="board" size="icon" aria-label="Настройки маркера" title="Настройки маркера">
          <span aria-hidden="true" className="size-3 shrink-0 rounded-full border border-black/20" style={{ backgroundColor: rgbToCss(color) }} />
          <span aria-hidden="true" className="text-[10px] tabular-nums">{size}</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent side="right" align="center" sideOffset={8} collisionPadding={12}
        aria-label="Настройки маркера" className="w-60 rounded-xl border-neutral-200 bg-white p-2 shadow-lg data-[state=closed]:animate-none data-[state=closed]:hidden"
        onKeyDown={(event) => event.stopPropagation()} onEscapeKeyDown={(event) => event.stopPropagation()}>
        <DropdownMenuLabel className="px-2 text-xs font-medium text-neutral-500">Цвет маркера</DropdownMenuLabel>
        <div role="group" aria-label="Цвет маркера" className="grid grid-cols-4 gap-2 p-1">
          {COLORS.map((option) => {
            const checked = color.r === option.color.r && color.g === option.color.g && color.b === option.color.b && (color.a ?? 1) === 1;
            return <DropdownMenuItem key={option.name} role="menuitemradio" aria-label={`Цвет маркера: ${option.name}`}
              aria-checked={checked} title={option.name}
              onSelect={(event) => { event.preventDefault(); onColorChange(option.color); onActivate(); }}
              className="flex size-11 cursor-pointer items-center justify-center rounded-md border border-black/15 p-0 focus:ring-2 focus:ring-emerald-500"
              style={{ backgroundColor: rgbToCss(option.color), color: getContrastingTextColor(option.color) }}>
              {checked && <Check aria-hidden="true" className="size-5 text-inherit" />}
            </DropdownMenuItem>;
          })}
        </div>
        <DropdownMenuLabel className="px-2 pb-1 pt-3 text-xs font-medium text-neutral-500">Толщина маркера</DropdownMenuLabel>
        <PenSizePicker currentSize={size} onChange={(next) => { onSizeChange(next); onActivate(); }} />
      </DropdownMenuContent>
    </DropdownMenu>
  </div>;
}
