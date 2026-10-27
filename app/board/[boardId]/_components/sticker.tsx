"use client";

import { useState } from "react";
import { rgbToCss, getContrastingTextColor } from "@/lib/utils";
import { StickerLayer } from "@/types/board-canvas";
import { RichTextContent } from "@/components/board-text/content";
import { resolveBoardFont } from "@/lib/board/fonts";


interface StickerProps {
    id: string;
    layer: StickerLayer;
    onPointerDown: (e: React.PointerEvent, id: string) => void;
    selectionColor?: string
}
export const Sticker = ({ id, layer, onPointerDown, selectionColor }: StickerProps) => {
    const { x, y, width, height, fill, fontSize } = layer;
    const [measuredHeight, setMeasuredHeight] = useState(height);

    return (
        <foreignObject
            x={x}
            y={y}
            width={width}
            height={Math.max(height, measuredHeight)}
            onPointerDown={(e) => onPointerDown(e, id)}
            style ={{
                outline: selectionColor ? `2px solid ${selectionColor}` : 'none',
                background: fill ? rgbToCss(fill) : '#000'
            }}
            className="drop-shadow-xl shadow-md"
        >
            <RichTextContent
                id={id}
                minHeight={100}
                onHeight={setMeasuredHeight}
                className="text-center outline-none"
                style={{
                    fontSize: fontSize,
                    fontFamily: resolveBoardFont(layer.fontFamily),
                    color: fill ? getContrastingTextColor(fill) : '#000'
                 }}
            />
        </foreignObject>
    );
}
