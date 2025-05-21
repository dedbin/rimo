"use client";

import { LayerType } from "@/types/board-canvas";
import { useStorage } from "@liveblocks/react/suspense";
import { memo } from "react";
import { Rectangle } from "./rectangle";
import { Ellipse } from "./ellipse";
import { Text } from "./text";
import { Sticker } from "./sticker";

interface LayerPreviewProps {
    id: string,
    onLayerPointerDown: (e: React.PointerEvent, id: string) => void
    selectionColor?: string
}

export const LayerPreview: React.FC<LayerPreviewProps> = memo(({ id, onLayerPointerDown, selectionColor }) => {
    const layer = useStorage((root) => root.layers.get(id));
    if (!layer) return null;

    switch (layer.type) {
        case LayerType.Text:
            return (
                <Text
                    id={id}
                    layer={layer}
                    onPointerDown={onLayerPointerDown}
                    selectionColor={selectionColor}
                />
            )
        case LayerType.Ellipse:
            return (
                <Ellipse
                    id={id}
                    layer={layer}
                    onPointerDown={onLayerPointerDown}
                    selectionColor={selectionColor}
                />
            )
        case LayerType.Rectangle:
            return (
                <Rectangle
                    id={id}
                    layer={layer}
                    onPointerDown={onLayerPointerDown}
                    selectionColor={selectionColor}
                />
            );
        case LayerType.Sticker:
            return (
                <Sticker
                    id={id}
                    layer={layer}
                    onPointerDown={onLayerPointerDown}
                    selectionColor={selectionColor}
                />
            );
        default:
            console.warn(`Unknown layer type: ${layer.type}`);
            return null
    }
});

LayerPreview.displayName = "LayerPreview";