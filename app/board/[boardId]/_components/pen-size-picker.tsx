"use client";

import { Hint } from "@/components/hint";

interface PenSizePickerProps {
  onChange: (size: number) => void;
  currentSize: number;
}

export const PenSizePicker = ({ onChange, currentSize }: PenSizePickerProps) => {
  const sizes = [4, 8, 12, 16, 24, 32];

  return (
    <div className="flex items-center bg-white border border-neutral-200 rounded-lg shadow-sm p-2">
      {sizes.map((size) => {
        const isActive = size === currentSize;
        return (
          <Hint key={size} label={`${size}px`} side="top" sideOffset={6}>
            <button
              onClick={() => onChange(size)}
              className={`
                relative flex items-center justify-center mx-1
                w-8 h-8
                focus:outline-none
                ${isActive 
                  ? "ring-2 ring-blue-500" 
                  : "hover:bg-neutral-100"}
                rounded-full
              `}
            >
              <div
                className="rounded-full bg-black"
                style={{ width: size, height: size }}
              />
              {isActive && (
                <span className="absolute -top-1 -right-1 w-2 h-2 bg-blue-500 rounded-full" />
              )}
            </button>
          </Hint>
        );
      })}
    </div>
  );
};