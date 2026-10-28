"use client";

import { useState } from "react";
import { rgbToCss } from "@/lib/utils";
import { TextLayer } from "@/types/board-canvas";
import { RichTextContent } from "@/components/board-text/content";
import { resolveBoardFont } from "@/lib/board/fonts";


interface TextProps {
    id: string;
    layer: TextLayer;
    onPointerDown: (e: React.PointerEvent, id: string) => void;
    selectionColor?: string
}
export const Text = ({ id, layer, onPointerDown, selectionColor }: TextProps) => {
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
                outline: selectionColor ? `2px solid ${selectionColor}` : 'none'
            }}
        >
            <RichTextContent
                id={id}
                minHeight={Math.ceil(fontSize * 1.4) + 8}
                onHeight={setMeasuredHeight}
                className="text-center drop-shadow-md outline-none"
                style={{
                    fontSize: fontSize,
                    color: fill ? rgbToCss(fill) : '#000',
                    fontFamily: resolveBoardFont(layer.fontFamily),
                 }}
            />
        </foreignObject>
    );
}
