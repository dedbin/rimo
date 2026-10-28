"use client";

import { motion } from "motion/react";
import { LinkPreviewLayer } from "@/types/board-canvas";
import { cn } from "@/lib/utils";

interface LinkPreviewProps {
  id: string;
  layer: LinkPreviewLayer;
  onPointerDown: (event: React.PointerEvent, id: string) => void;
  selectionColor?: string;
}

export function LinkPreview({ id, layer, onPointerDown, selectionColor }: LinkPreviewProps) {
  const { x, y, width, height, value: url } = layer;
  let hostname = "Ссылка";
  try { hostname = new URL(url).hostname; } catch { /* Invalid layers are rejected by the document parser. */ }
  return <foreignObject x={x} y={y} width={width} height={height}
    onPointerDown={(event) => onPointerDown(event, id)}
    style={{ outline: selectionColor ? `2px solid ${selectionColor}` : undefined, userSelect: "none" }}>
    <motion.div className={cn(
      "select-none w-full h-full bg-white dark:bg-gray-800 rounded-2xl border border-neutral-200 dark:border-gray-700 shadow-lg overflow-hidden",
      "flex flex-col transition-transform duration-300 ease-out hover:scale-105",
    )} initial={{ opacity: 0, scale: 0.98 }} animate={{ opacity: 1, scale: 1 }}>
      <div className="flex-1 flex overflow-hidden">
        <div className="flex flex-col justify-between p-4 flex-1 overflow-hidden">
          <div className="flex items-center gap-2 mb-1 text-xs text-gray-500 dark:text-gray-400 truncate">
            <div className="w-4 h-4 bg-gray-200 rounded-full" /><span className="truncate">{hostname}</span>
          </div>
          <h3 className="font-semibold text-sm text-gray-900 dark:text-white truncate">{layer.title || hostname}</h3>
          <p className="text-xs text-gray-600 dark:text-gray-300 line-clamp-3 mt-1">{layer.description || url}</p>
          <div className="mt-3"><a href={url} target="_blank" rel="noopener noreferrer"
            onPointerDown={(event) => event.stopPropagation()}
            className="inline-flex items-center text-xs font-medium text-blue-600 dark:text-blue-400 hover:underline">Перейти</a></div>
        </div>
        <div className="hidden sm:block w-1/3 h-full bg-gradient-to-tr from-gray-100 via-gray-50 to-gray-100 dark:from-gray-700 dark:to-gray-700" />
      </div>
    </motion.div>
  </foreignObject>;
}
