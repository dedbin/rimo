"use client";

import { rgbToCss, cn, getContrastingTextColor } from "@/lib/utils";
import { StickerLayer } from "@/types/board-canvas";
import localFont from "next/font/local";
import { PlainTextContent } from "./plain-text-content";

const font = localFont({
    src: "../../../../node_modules/@fontsource/poppins/files/poppins-latin-400-normal.woff2",
    weight: "400",
    display: "swap",
})


interface StickerProps {
    id: string;
    layer: StickerLayer;
    onPointerDown: (e: React.PointerEvent, id: string) => void;
    selectionColor?: string
}
export const Sticker = ({ id, layer, onPointerDown, selectionColor }: StickerProps) => {
    const { x, y, width, height, fill, value, fontSize } = layer

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
            <PlainTextContent
                id={id}
                value={value ?? ""}
                className={cn("h-full w-full flex items-center justify-center text-center outline-none", font.className)}
                style={{
                    fontSize: fontSize,
                    color: fill ? getContrastingTextColor(fill) : '#000'
                 }}
            />
        </foreignObject>
    );
}
