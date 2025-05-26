"use client";

import React, { useEffect, useState } from "react";
import { motion } from "framer-motion";
import { LinkPreviewLayer } from "@/types/board-canvas";
import { cn } from "@/lib/utils";

interface PreviewData {
  title?: string;
  description?: string;
  image?: string;
  favicon?: string;
}

interface LinkPreviewProps {
  id: string;
  layer: LinkPreviewLayer;
  onPointerDown: (e: React.PointerEvent, id: string) => void;
  selectionColor?: string;
}

export const LinkPreview: React.FC<LinkPreviewProps> = ({
  id,
  layer,
  onPointerDown,
  selectionColor,
}) => {
  const { x, y, width, height, value: url } = layer;
  const hostname = React.useMemo(() => new URL(url).hostname, [url]);

  const [data, setData] = useState<PreviewData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  useEffect(() => {
    let canceled = false;
    setLoading(true);
    fetch(`/api/fetch-link-preview?url=${encodeURIComponent(url)}`)
      .then((res) => {
        if (!res.ok) throw new Error("Fetch error");
        return res.json();
      })
      .then((json: PreviewData) => {
        if (!canceled) {
          setData(json);
          setError(false);
        }
      })
      .catch(() => {
        if (!canceled) setError(true);
      })
      .finally(() => {
        if (!canceled) setLoading(false);
      });
    return () => {
      canceled = true;
    };
  }, [url]);

  return (
    <foreignObject
      x={x}
      y={y}
      width={width}
      height={height}
      onPointerDown={(e) => onPointerDown(e, id)}
      style={{ outline: selectionColor ? `2px solid ${selectionColor}` : undefined, userSelect: 'none' }}
    >
      <motion.div
        className={cn(
          "select-none w-full h-full bg-white dark:bg-gray-800 rounded-2xl border border-neutral-200 dark:border-gray-700 shadow-lg overflow-hidden",
          "flex flex-col transition-transform duration-300 ease-out hover:scale-105"
        )}
        initial={{ opacity: 0, scale: 0.98 }}
        animate={{ opacity: 1, scale: 1 }}
      >
        {/* Loading Skeleton */}
        {loading && (
          <div className="animate-pulse flex-1 p-4 flex flex-col justify-between">
            <div className="flex items-center gap-2 mb-2">
              <div className="w-4 h-4 bg-gray-200 rounded-full" />
              <div className="h-3 bg-gray-200 rounded w-1/4" />
            </div>
            <div className="space-y-2">
              <div className="h-4 bg-gray-200 rounded w-3/4" />
              <div className="h-4 bg-gray-200 rounded w-2/4" />
              <div className="h-4 bg-gray-200 rounded w-1/4" />
            </div>
            <div className="h-6 bg-gray-200 rounded w-1/3 mt-4 self-start" />
          </div>
        )}

        {/* Error Fallback */}
        {!loading && error && (
          <div className="flex-1 p-4 flex items-center justify-center text-sm text-red-500">
            Не удалось загрузить превью
          </div>
        )}

        {/* Content */}
        {!loading && !error && data && (
          <div className="flex-1 flex overflow-hidden">
            <div className="flex flex-col justify-between p-4 flex-1 overflow-hidden">
              <div className="flex items-center gap-2 mb-1 text-xs text-gray-500 dark:text-gray-400 truncate">
                {data.favicon ? (
                  <img src={data.favicon} alt="favicon" className="w-4 h-4 rounded-full" />
                ) : (
                  <div className="w-4 h-4 bg-gray-200 dark:bg-gray-600 rounded-full" />
                )}
                <span className="truncate">{hostname}</span>
              </div>

              <h3 className="font-semibold text-sm text-gray-900 dark:text-white truncate">
                {data.title || url}
              </h3>

              {data.description && (
                <p className="text-xs text-gray-600 dark:text-gray-300 line-clamp-3 mt-1">
                  {data.description}
                </p>
              )}

              <div className="mt-3">
                <a
                  href={url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center text-xs font-medium text-blue-600 dark:text-blue-400 hover:underline"
                >
                  Перейти
                </a>
              </div>
            </div>

            {/* Preview Image */}
            {data.image ? (
              <motion.div
                className="w-full sm:w-1/3 h-full relative overflow-hidden"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{ delay: 0.2 }}
              >
                <img
                  src={data.image}
                  alt="preview"
                  className="w-full h-full object-cover"
                  loading="lazy"
                />
              </motion.div>
            ) : (
              <div className="hidden sm:block w-1/3 h-full bg-gradient-to-tr from-gray-100 via-gray-50 to-gray-100 dark:from-gray-700 dark:via-gray-800 dark:to-gray-700" />
            )}
          </div>
        )}
      </motion.div>
    </foreignObject>
  );
};