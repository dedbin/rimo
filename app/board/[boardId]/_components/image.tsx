"use client";

import { ImageLayer } from "@/types/board-canvas";
import { useState } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import NextImage from "next/image";

interface ImageProps {
    id: string;
    layer: ImageLayer;
    onPointerDown: (e: React.PointerEvent, id: string) => void;
    selectionColor?: string;
    alt?: string;
}

export const Image = ({ id, layer, onPointerDown, selectionColor, alt }: ImageProps) => {
    const { x, y, width, height, src } = layer;

    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(false);
    
    return (
        <foreignObject
            x={x}
            y={y}
            width={width}
            height={height}
            onPointerDown={(e) => onPointerDown(e, id)}
            style={{
                outline: selectionColor ? `4px solid ${selectionColor}` : "none",
            }}
            className="drop-shadow-md"
        >
            {loading && !error && (
                <Skeleton className="w-full h-full" />
            )}
            {error && (
                <div className="flex-1 relative flex items-center justify-center text-sm">
                    <NextImage
                        src="/link-preview-error.jpg"
                        alt="error"
                        fill
                        className="absolute inset-0 w-full h-full object-fill scale-y opacity-50 pointer-events-none"
                    />
                    <span className="relative z-10 text-red-600 drop-shadow-md font-bold text-lg">Не удалось загрузить превью</span>
                </div>
            )}
            <NextImage
                src={src}
                unoptimized
                loading="eager"
                width={Math.max(1, width)}
                height={Math.max(1, height)}
                alt={alt || "image"}
                onLoad={() => setLoading(false)}
                onError={() => { setError(true); setLoading(false); }}
                style={{
                    width: "100%",
                    height: "100%",
                    objectFit: "contain",
                    pointerEvents: "none",
                    userSelect: "none",
                    display: loading || error ? "none" : "block",
                }}
            />
        </foreignObject>
    );
};
