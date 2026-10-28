import { useCallback } from "react";
import { useBoardRuntime } from "@/lib/collaboration/react";

export const useDeleteLayers = () => {
  const runtime = useBoardRuntime();
  return useCallback(() => {
    runtime.board.remove(runtime.getSelf().presence.selection);
    runtime.updatePresence({ selection: [] });
  }, [runtime]);
};
