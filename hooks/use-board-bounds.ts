import { Layer, XYWH } from "@/types/board-canvas";
import { shallow as shallowEq } from "@liveblocks/react";
import { useStorage } from "@liveblocks/react/suspense";

const computeEnclosure = (items: Layer[]): XYWH | null => {
  if (items.length === 0) return null;

  const xs: number[] = [];
  const ys: number[] = [];

  for (const { x, y, width, height } of items) {
    xs.push(x, x + width);
    ys.push(y, y + height);
  }

  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);

  return {
    x: minX,
    y: minY,
    width: maxX - minX,
    height: maxY - minY,
  };
};

export function useBoardBounds() {
  return useStorage(
    (state) => {
      const layers: Layer[] = state.layerIds
        .map((id) => state.layers.get(id))
        .filter((layer): layer is Layer => Boolean(layer));

      return computeEnclosure(layers);
    },
    shallowEq
  );
}
