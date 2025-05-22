"use client";

import { Layer, LayerType } from "@/types/board-canvas";
import { useStorage } from "@liveblocks/react/suspense";
import { memo } from "react";
import { Rectangle } from "./rectangle";
import { Ellipse } from "./ellipse";
import { Text } from "./text";
import { Sticker } from "./sticker";
import { Path } from "./path";
import { Image } from "./image";
import { rgbToCss } from "@/lib/utils";

interface LayerPreviewProps {
  id: string;
  onLayerPointerDown: (e: React.PointerEvent, id: string) => void;
  selectionColor?: string;
}

export const LayerPreview: React.FC<LayerPreviewProps> = memo(
  ({ id, onLayerPointerDown, selectionColor }) => {
    const layer = useStorage((root): Layer | undefined => root.layers.get(id));
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
        );
      case LayerType.Ellipse:
        return (
          <Ellipse
            id={id}
            layer={layer}
            onPointerDown={onLayerPointerDown}
            selectionColor={selectionColor}
          />
        );
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
      case LayerType.Path:
        return (
             <Path
                points={layer.points}
                onPointerDown={(e) => onLayerPointerDown(e, id)}
                x={layer.x}
                y={layer.y}
                fill={layer.fill ? rgbToCss(layer.fill) : "#000"}
                stroke={selectionColor}
                size={layer.size ?? 16}
            />
        );
      case LayerType.Image:
        return (
          <Image
            id={id}
            layer={layer}
            onPointerDown={onLayerPointerDown}
            selectionColor={selectionColor}
          />
        );

      default:
        console.warn(`Unknown layer type: ${(layer as Layer).type}`);
        return null;
    }
  }
);

LayerPreview.displayName = "LayerPreview";
