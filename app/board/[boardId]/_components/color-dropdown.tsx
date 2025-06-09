"use client";

import { useState } from "react";
import { ChevronDown } from "lucide-react";
import { AnimatePresence, motion } from "framer-motion";
import { Color } from "@/types/board-canvas";
import { rgbToCss } from "@/lib/utils";
import { cn } from "@/lib/utils";

interface ColorDropdownProps {
  onChange: (color: Color) => void;
  currentColor: Color;
}

const colors: Color[] = [
  { r: 0, g: 0, b: 0 },
  { r: 255, g: 255, b: 255 },
  { r: 52, g: 211, b: 153 },
  { r: 59, g: 130, b: 246 },
  { r: 168, g: 85, b: 247 },
  { r: 239, g: 68, b: 68 },
  { r: 234, g: 179, b: 8 },
  { r: 249, g: 115, b: 22 },
];

export const ColorDropdown = ({ currentColor, onChange }: ColorDropdownProps) => {
  const [open, setOpen] = useState(false);

  return (
    <div className="relative inline-block">
      <button
        onClick={() => setOpen((prev) => !prev)}
        className={cn(
            "h-7.5 min-w-[44px] flex items-center justify-between gap-1 px-2 py-1 border rounded-md text-sm shadow-sm bg-white",
            open ? "border-green-500 text-green-500" : "border-neutral-300"
        )}
      >
        <div
          className="w-4 h-4 rounded-sm border border-neutral-300"
          style={{ backgroundColor: rgbToCss(currentColor) }}
        />
        <ChevronDown className="w-4 h-4" />
      </button>

        <AnimatePresence>
            {open && (
                <motion.div
                    initial={{ opacity: 0, y: 4 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: 4 }}
                    transition={{ duration: 0.15 }}
                    className="absolute left-1/2 -translate-x-1/2 mt-2 z-10 bg-white border border-neutral-200 rounded-md shadow-md"
                    >
                    <div className="grid grid-cols-4 gap-2 p-2 w-[112px]">
                        {colors.map((color, index) => (
                        <button
                            key={index}
                            className="w-6 h-6 rounded-sm border border-neutral-300 hover:ring-2 hover:ring-blue-500"
                            style={{ backgroundColor: rgbToCss(color) }}
                            onClick={() => {
                            onChange(color);
                            setOpen(false);
                            }}
                        />
                        ))}
                    </div>
                </motion.div>
            )}
        </AnimatePresence>
    </div>
  );
};
