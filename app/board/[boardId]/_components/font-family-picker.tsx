"use client";

import { useState } from "react";
import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";
import { motion, AnimatePresence } from "framer-motion";

interface FontFamilyPickerProps {
  onChange: (font: string) => void;
  currentFont: string;
}

const fontFamilies = [
  "Noto Sans",
  "Inter",
  "Roboto",
  "Courier New",
  "Georgia",
  "Comic Sans MS",
];

export const FontFamilyPicker = ({ onChange, currentFont }: FontFamilyPickerProps) => {
  const [isOpen, setIsOpen] = useState(false);

  return (
    <div className="relative inline-block text-left min-w-[140px]">
      <button
        onClick={() => setIsOpen(!isOpen)}
        className={cn(
          "w-full inline-flex items-center justify-between px-2 py-1 border bg-white rounded-md shadow-sm text-sm transition-colors",
          isOpen ? "border-green-500 text-green-500" : "border-neutral-300"
        )}
      >
        {currentFont}
        <ChevronDown className="ml-1 h-4 w-4" />
      </button>

      <AnimatePresence>
        {isOpen && (
          <motion.div
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 4 }}
            transition={{ duration: 0.2 }}
            className="absolute z-10 mt-2 w-full bg-white border border-neutral-200 rounded-md shadow-lg max-h-60 overflow-y-auto"
          >
            {fontFamilies.map((font) => (
              <button
                key={font}
                onClick={() => {
                  onChange(font);
                  setIsOpen(false);
                }}
                className={cn(
                  "block w-full px-2 py-1 text-left text-sm hover:bg-neutral-100",
                  font === currentFont ? "bg-blue-500 text-white" : ""
                )}
                style={{ fontFamily: font }}
              >
                {font}
              </button>
            ))}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
};
