"use client";

import { rgbToCss } from "@/lib/utils";
import { EllipseLayer } from "@/types/board-canvas";

interface EllipseProps {
    id: string;
    layer: EllipseLayer;
    onPointerDown: (e: React.PointerEvent, id: string) => void;
    selectionColor?: string
}

export const Ellipse = ({ id, layer, onPointerDown, selectionColor }: EllipseProps) => {
    const { x, y, width, height, fill, stroke, strokeWidth } = layer
    return (
        <ellipse
            className={fill.a === 0 ? undefined : "drop-shadow-md"}
            style={{transform: `translate(${x}px, ${y}px)`,} }
            x={0}
            y={0}
            cx={width/2}
            cy={height/2}
            rx={width/2}
            ry={height/2}
            fill={fill ? rgbToCss(fill) : '#000'}
            stroke={selectionColor || (stroke ? rgbToCss(stroke) : 'transparent')}
            strokeWidth={selectionColor ? 4 : strokeWidth ?? 0}
            pointerEvents="all"
            onPointerDown={(e) => onPointerDown(e, id)}
        />
    );
}
