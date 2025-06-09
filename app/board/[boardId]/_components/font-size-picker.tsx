"use client";

import { Hint } from "@/components/hint";
import { cn } from "@/lib/utils";

interface FontSizePickerProps {
  onChange: (size: number) => void;
  currentSize: number;
}

export const FontSizePicker = ({ onChange, currentSize }: FontSizePickerProps) => {
  const sizes = [12, 16, 20, 24, 32, 48];

  return (
    <div className="flex items-center bg-white border border-neutral-200 rounded-lg shadow-sm p-2">
      {sizes.map((size) => {
        const isActive = size === currentSize;
        return (
          <Hint key={size} label={`${size}px`} side="top" sideOffset={6}>
            <button
              onClick={() => onChange(size)}
              className={cn(
                "px-2 py-1 mx-1 rounded-md text-sm",
                isActive ? "bg-blue-500 text-white" : "hover:bg-neutral-100"
              )}
            >
              {size}
            </button>
          </Hint>
        );
      })}
    </div>
  );
};