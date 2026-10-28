import { useMemo } from "react";
import { getBounds } from "@/lib/board/geometry";
import { useBoardSnapshot, useSelection } from "@/lib/collaboration/react";

export function useActiveSelectionArea() {
  const selection = useSelection();
  const snapshot = useBoardSnapshot();
  return useMemo(() => getBounds(selection.map((id) => snapshot.layers.get(id))
    .filter((layer) => layer !== undefined)), [snapshot, selection]);
}
