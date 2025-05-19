"use client";

import { rgbToCss } from "@/lib/utils";
import { RectangleLayer } from "@/types/board-canvas";

interface RectangleProps {
    id: string;
    layer: RectangleLayer;
    onPointerDown: (e: React.PointerEvent, id: string) => void;
    selectionColor?: string
}

export const Rectangle = ({ id, layer, onPointerDown, selectionColor }: RectangleProps) => {
    const { x, y, width, height, fill } = layer
    return (
        <rect
            className="drop-shadow-md"
            style={{transform: `translate(${x}px, ${y}px)`,}}
            x={0}
            y={0}
            width={width}
            height={height}
            fill={fill ? rgbToCss(fill) : '#000'}
            stroke={selectionColor || 'transparent'}
            strokeWidth={4}
            onPointerDown={(e) => onPointerDown(e, id)}
        />
    );
}