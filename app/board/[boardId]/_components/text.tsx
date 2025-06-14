"use client";

import { rgbToCss, cn } from "@/lib/utils";
import { TextLayer } from "@/types/board-canvas";
import ContentEditable, { ContentEditableEvent } from "react-contenteditable";
import { useMutation } from "@liveblocks/react";


interface TextProps {
    id: string;
    layer: TextLayer;
    onPointerDown: (e: React.PointerEvent, id: string) => void;
    selectionColor?: string
}
export const Text = ({ id, layer, onPointerDown, selectionColor }: TextProps) => {
    const { x, y, width, height, fill, value, fontSize } = layer

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
                outline: selectionColor ? `2px solid ${selectionColor}` : 'none'
            }}
        >
            <ContentEditable
                html={value || "text"}
                spellCheck={!!selectionColor} 
                autoCorrect="off"
                autoComplete="off"
                onChange={handleContentEditableChange}
                className={cn("h-full w-full flex items-center justify-center text-center drop-shadow-md outline-none", layer.fontFamily)}
                style={{
                    fontSize: fontSize,
                    color: fill ? rgbToCss(fill) : '#000',
                    fontFamily: layer.fontFamily || "sans-serif",
                 }}
            />
        </foreignObject>
    );
}