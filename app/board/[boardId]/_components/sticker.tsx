"use client";

import { rgbToCss, cn, getContrastingTextColor } from "@/lib/utils";
import { StickerLayer } from "@/types/board-canvas";
import { Poppins } from "next/font/google";
import ContentEditable, { ContentEditableEvent } from "react-contenteditable";
import { useMutation } from "@liveblocks/react";

const MAX_FONT_SIZE = 96;
const SCALE_FACTOR = 0.15;
const MIN_FONT_SIZE = 12;

const font = Poppins({
    subsets: ['latin'],
    weight: ['400'],
})

const calculateFontSize = (width: number, height: number) => {
    const fontSizeHeight = height * SCALE_FACTOR;
    const fontSizeWidth = width * SCALE_FACTOR; 

    const size = Math.min(MAX_FONT_SIZE, Math.min(fontSizeHeight, fontSizeWidth));
    return Math.max(MIN_FONT_SIZE, size);   
}



interface StickerProps {
    id: string;
    layer: StickerLayer;
    onPointerDown: (e: React.PointerEvent, id: string) => void;
    selectionColor?: string
}
// TODO: add selection font
export const Sticker = ({ id, layer, onPointerDown, selectionColor }: StickerProps) => {
    const { x, y, width, height, fill, value } = layer

    const updateValue = useMutation(({ storage }, newValue: string) => {
        const liveLayers = storage.get("layers");

        liveLayers.get(id)?.set("value", newValue);
    }, [])

    const handleContentEditableChange = (e: ContentEditableEvent) => {
        updateValue(e.target.value);
    }

    return (
        <foreignObject
            x={x}
            y={y}
            width={width}
            height={height}
            onPointerDown={(e) => onPointerDown(e, id)}
            style ={{
                outline: selectionColor ? `2px solid ${selectionColor}` : 'none',
                background: fill ? rgbToCss(fill) : '#000'
            }}
            className="drop-shadow-xl shadow-md"
        >
            <ContentEditable
                html={value || "text"}
                spellCheck={!!selectionColor} 
                autoCorrect="off"
                autoComplete="off"
                onChange={handleContentEditableChange}
                className={cn("h-full w-full flex items-center justify-center text-center outline-none", font.className)}
                style={{ 
                    fontSize: calculateFontSize(width, height),
                    color: fill ? getContrastingTextColor(fill) : '#000'
                 }}
            />
        </foreignObject>
    );
}