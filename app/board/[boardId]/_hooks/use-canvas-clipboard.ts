"use client";

import { useCallback, useEffect, useRef } from "react";
import { toast } from "sonner";
import { useBoardRuntime } from "@/lib/collaboration/react";
import { BOARD_CLIPBOARD_MIME, isEditingTarget, offsetLayers, parseBoardClipboard, serializeLayers } from "@/lib/board/clipboard";
import { uploadBoardImage } from "@/lib/board/assets-client";
import { BoardCanvasMode, BoardCanvasState, Color, LayerType } from "@/types/board-canvas";

interface Options {
  color: Color;
  cancel: () => void;
  setCanvasState: (state: BoardCanvasState) => void;
}

export function useCanvasClipboard({ color, cancel, setCanvasState }: Options) {
  const runtime = useBoardRuntime();
  const pasteCount = useRef(0);
  const lastPaste = useRef("");
  const insertImage = useCallback(async (file: File) => {
    if (!runtime.board.canEdit) return;
    try {
      const position = runtime.getSelf().presence.cursor ?? { x: 100, y: 100 };
      const asset = await uploadBoardImage(runtime.session.board.id, file);
      if (!runtime.board.canEdit) return;
      const ratio = Math.min(1, 600 / Math.max(asset.width, asset.height));
      const ids = runtime.board.insert([{ type: LayerType.Image, ...position,
        width: asset.width * ratio, height: asset.height * ratio, src: asset.url }]);
      runtime.updatePresence({ selection: ids });
    } catch (error) { toast.error(error instanceof Error ? error.message : "Не удалось вставить изображение"); }
  }, [runtime]);

  const duplicate = useCallback(() => {
    const snapshot = runtime.board.getSnapshot();
    const selected = runtime.getSelf().presence.selection.filter((id) => snapshot.layers.has(id));
    const layers = selected.map((id) => snapshot.layers.get(id)!);
    const richText = selected.map((id) => {
      const layer = snapshot.layers.get(id);
      return layer?.type === LayerType.Text || layer?.type === LayerType.Sticker ? runtime.board.getRichText(id) : null;
    });
    try {
      const ids = runtime.board.insert(layers.map((layer) => ({ ...layer, x: layer.x + 32, y: layer.y + 32 })), richText);
      runtime.updatePresence({ selection: ids });
    } catch (error) { toast.error(error instanceof Error ? error.message : "Не удалось создать копию"); }
  }, [runtime]);

  useEffect(() => {
    const copy = (event: ClipboardEvent) => {
      if (isEditingTarget(event.target)) return;
      const selection = new Set(runtime.getSelf().presence.selection);
      const snapshot = runtime.board.getSnapshot();
      const ids = snapshot.layerIds.filter((id) => selection.has(id));
      const layers = ids.map((id) => snapshot.layers.get(id)).filter((layer) => layer !== undefined);
      if (!layers.length || !event.clipboardData) return;
      const richText = ids.map((id) => {
        const layer = snapshot.layers.get(id);
        return layer?.type === LayerType.Text || layer?.type === LayerType.Sticker ? runtime.board.getRichText(id) : null;
      });
      const payload = serializeLayers(layers, richText);
      event.clipboardData.setData(BOARD_CLIPBOARD_MIME, payload);
      event.clipboardData.setData("text/plain", payload);
      event.preventDefault();
    };
    const paste = (event: ClipboardEvent) => {
      if (isEditingTarget(event.target) || !runtime.board.canEdit || !event.clipboardData) return;
      const text = event.clipboardData.getData(BOARD_CLIPBOARD_MIME) || event.clipboardData.getData("text/plain");
      const position = runtime.getSelf().presence.cursor ?? { x: 100, y: 100 };
      const copied = parseBoardClipboard(text);
      try {
        if (copied) {
          event.preventDefault();
          pasteCount.current = lastPaste.current === text ? pasteCount.current + 1 : 0;
          lastPaste.current = text;
          const padding = pasteCount.current * 32;
          runtime.updatePresence({ selection: runtime.board.insert(offsetLayers(copied.layers, position.x + padding, position.y + padding), copied.richText) });
          return;
        }
        if (text) {
          event.preventDefault();
          if (/^https?:\/\/\S+$/.test(text) && text.length <= 2048) {
            const url = new URL(text);
            if (!url.username && !url.password) {
              const ids = runtime.board.insert([{ type: LayerType.LinkPreview, ...position,
                width: 400, height: 150, value: url.href, title: url.hostname, description: url.href }]);
              runtime.updatePresence({ selection: ids });
              return;
            }
          }
          const ids = runtime.board.insert([{ type: LayerType.Text, ...position,
            width: 300, height: 100, fill: color, fontSize: 16, fontFamily: "Noto Sans", value: text }]);
          runtime.updatePresence({ selection: ids });
          return;
        }
        const files = Array.from(event.clipboardData.items).filter((item) => item.type.startsWith("image/"));
        if (files.length) event.preventDefault();
        for (const item of files) {
          const file = item.getAsFile();
          if (file) void insertImage(file);
        }
      } catch (error) { toast.error(error instanceof Error ? error.message : "Не удалось вставить данные"); }
    };
    const keyboard = (event: KeyboardEvent) => {
      if (isEditingTarget(event.target)) return;
      const modifier = event.ctrlKey || event.metaKey;
      if (event.key === "Escape") {
        cancel();
        runtime.updatePresence({ selection: [] });
        return;
      }
      if (!runtime.board.canEdit) return;
      if (modifier && !event.altKey) {
        const commands: Record<string, () => void> = {
          KeyZ: event.shiftKey ? runtime.board.redo : runtime.board.undo,
          KeyY: runtime.board.redo,
          KeyD: duplicate,
          KeyP: () => setCanvasState({ mode: BoardCanvasMode.Pencil }),
          KeyE: () => setCanvasState({ mode: BoardCanvasMode.Eraser }),
          KeyT: () => setCanvasState({ mode: BoardCanvasMode.Inserting, layerType: LayerType.Text }),
          KeyS: () => setCanvasState({ mode: BoardCanvasMode.Inserting, layerType: LayerType.Sticker }),
          KeyR: () => setCanvasState({ mode: BoardCanvasMode.Inserting, layerType: LayerType.Rectangle }),
          KeyO: () => setCanvasState({ mode: BoardCanvasMode.Inserting, layerType: LayerType.Ellipse }),
        };
        const command = commands[event.code];
        if (command) { event.preventDefault(); command(); }
      } else if (event.key === "Delete" || event.key === "Backspace") {
        event.preventDefault();
        runtime.board.remove(runtime.getSelf().presence.selection);
        runtime.updatePresence({ selection: [] });
      }
    };
    window.addEventListener("copy", copy);
    window.addEventListener("paste", paste);
    window.addEventListener("keydown", keyboard);
    return () => {
      window.removeEventListener("copy", copy);
      window.removeEventListener("paste", paste);
      window.removeEventListener("keydown", keyboard);
    };
  }, [runtime, color, cancel, setCanvasState, duplicate, insertImage]);

  return { insertImage };
}
