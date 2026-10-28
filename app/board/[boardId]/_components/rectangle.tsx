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
    const { x, y, width, height, fill, stroke, strokeWidth } = layer
    return (
        <rect
            className={fill.a === 0 ? undefined : "drop-shadow-md"}
            style={{transform: `translate(${x}px, ${y}px)`,}}
            x={0}
            y={0}
            width={width}
            height={height}
            fill={fill ? rgbToCss(fill) : '#000'}
            stroke={selectionColor || (stroke ? rgbToCss(stroke) : 'transparent')}
            strokeWidth={selectionColor ? 4 : strokeWidth ?? 0}
            pointerEvents="all"
            onPointerDown={(e) => onPointerDown(e, id)}
        />
    );
}
