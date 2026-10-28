import { useMemo } from "react";
import { getBounds } from "@/lib/board/geometry";
import { useBoardSnapshot } from "@/lib/collaboration/react";

export function useBoardBounds() {
  const snapshot = useBoardSnapshot();
  return useMemo(() => getBounds([...snapshot.layers.values()]), [snapshot]);
}
