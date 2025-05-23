"use client";

import { ImageLayer } from "@/types/board-canvas";

interface ImageProps {
    id: string;
    layer: ImageLayer;
    onPointerDown: (e: React.PointerEvent, id: string) => void;
    selectionColor?: string;
    alt?: string;
}

export const Image = ({ id, layer, onPointerDown, selectionColor, alt }: ImageProps) => {
    const { x, y, width, height, src } = layer;
    
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
            <img 
                src={src} 
                alt={alt || "image"}
                style={{
                    width: "100%",
                    height: "100%",
                    objectFit: "contain",
                    pointerEvents: "none",
                    userSelect: "none",
                }}
            />
        </foreignObject>
    );
};
