"use client";

import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { PEN_SIZES } from "@/lib/board/pen-preferences";

interface PenSizePickerProps {
  onChange: (size: number) => void;
  currentSize: number;
}

export const PenSizePicker = ({ onChange, currentSize }: PenSizePickerProps) => {
  return (
    <div role="group" aria-label="Толщина маркера" className="grid grid-cols-3 gap-2 p-1">
      {PEN_SIZES.map((size) => {
        const isActive = size === currentSize;
        return (
          <DropdownMenuItem key={size} role="menuitemradio" aria-label={`Толщина маркера: ${size} пкс`} aria-checked={isActive}
            onSelect={(event) => { event.preventDefault(); onChange(size); }}
            className={`flex min-h-11 cursor-pointer flex-col justify-center gap-1 rounded-md border px-1 py-2 focus:bg-emerald-50 ${isActive ? "border-emerald-500 bg-emerald-50" : "border-neutral-200"}`}>
            <span aria-hidden="true" className="rounded-full bg-neutral-800" style={{ width: Math.max(3, size / 2), height: Math.max(3, size / 2) }} />
            <span className="text-xs tabular-nums">{size}</span>
          </DropdownMenuItem>
        );
      })}
    </div>
  );
};
