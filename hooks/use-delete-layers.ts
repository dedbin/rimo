import { useMutation, useSelf } from "@liveblocks/react";

export const useDeleteLayers = () => {
  const selection = (useSelf(me => me.presence.selection) ?? []) as string[];

  return useMutation(
    ({ storage, setMyPresence }) => {
      const livelayers = storage.get("layers");
      const ids = storage.get("layerIds");

      for (const id of selection) {
        livelayers.delete(id);
        const idx = ids.indexOf(id);
        if (idx >= 0) {
          ids.delete(idx);
        }
      }

      setMyPresence({ selection: [] }, { addToHistory: true });
    },
    [selection]
  );
};
