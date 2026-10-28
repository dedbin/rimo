"use client";

import { useState } from "react";
import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";
import { motion, AnimatePresence } from "motion/react";

interface FontSizePickerProps {
  onChange: (size: number) => void;
  currentSize: number;
}

const fontSizes = [10, 12, 14, 18, 24, 36, 48, 64, 80, 144, 288];

export const FontSizePicker = ({ onChange, currentSize }: FontSizePickerProps) => {
  const [isOpen, setIsOpen] = useState(false);

  return (
    <div className="relative inline-block text-left">
      <button
        onClick={() => setIsOpen(!isOpen)}
        className={cn(
          "inline-flex items-center px-2 py-1 border bg-white rounded-md shadow-sm text-sm transition-colors",
          isOpen ? "border-green-500 text-green-500" : "border-neutral-300"
        )}
      >
        {currentSize}
        <ChevronDown className="ml-1 h-4 w-4" />
      </button>

      <AnimatePresence>
        {isOpen && (
          <motion.div
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 4 }}
            transition={{ duration: 0.2 }}
            className="absolute z-10 mt-2 w-20 bg-white border border-neutral-200 rounded-md shadow-lg"
          >
            {fontSizes.map((size) => (
              <button
                key={size}
                onClick={() => {
                  onChange(size);
                  setIsOpen(false);
                }}
                className={cn(
                  "block w-full px-2 py-1 text-left text-sm hover:bg-neutral-100",
                  size === currentSize ? "bg-blue-500 text-white" : ""
                )}
              >
                {size}
              </button>
            ))}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
};
