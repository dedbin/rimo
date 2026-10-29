"use client";

import { useCallback, useEffect, useRef } from "react";
import { toast } from "sonner";
import { useBoardRuntime } from "@/lib/collaboration/react";
import { BOARD_CLIPBOARD_MIME, BoardClipboard, isEditingTarget, offsetLayers, parseBoardClipboard, serializeLayers } from "@/lib/board/clipboard";
import { uploadBoardImage, validateBoardImageFile } from "@/lib/board/assets-client";
import { insertBoardClipboard } from "@/lib/board/clipboard-transfer";
import { BoardCanvasMode, BoardCanvasState, Color, LayerType } from "@/types/board-canvas";
import { AssetSummary } from "@/types/service";

interface Options {
  color: Color;
  cancel: () => void;
  setCanvasState: (state: BoardCanvasState) => void;
}

export function useCanvasClipboard({ color, cancel, setCanvasState }: Options) {
  const runtime = useBoardRuntime();
  const pasteCount = useRef(0);
  const lastPaste = useRef("");
  const pending = useRef(new Set<AbortController>());
  useEffect(() => {
    const operations = pending.current;
    const abort = () => { operations.forEach((controller) => controller.abort()); operations.clear(); };
    let writable = runtime.board.canEdit;
    const unsubscribe = runtime.subscribeState(() => {
      const next = runtime.board.canEdit;
      const lost = writable && !next;
      writable = next;
      if (lost) abort();
    });
    return () => { unsubscribe(); abort(); };
  }, [runtime]);

  const runInsertion = useCallback(async (operation: (signal: AbortSignal) => Promise<string[]>, fallback: string) => {
    if (!runtime.board.canEdit) return;
    const controller = new AbortController();
    pending.current.add(controller);
    try {
      const ids = await operation(controller.signal);
      if (!controller.signal.aborted && ids.length) runtime.updatePresence({ selection: ids });
    } catch (error) {
      if (!controller.signal.aborted) toast.error(error instanceof Error ? error.message : fallback);
      controller.abort();
    } finally { pending.current.delete(controller); }
  }, [runtime]);

  const insertImages = useCallback((files: File[]) => runInsertion(async (signal) => {
    if (files.length > 100) throw new Error("За одну вставку можно загрузить до 100 изображений.");
    files.forEach(validateBoardImageFile);
    const position = runtime.getSelf().presence.cursor ?? { x: 100, y: 100 };
    const assets: AssetSummary[] = [];
    for (const file of files) {
      if (signal.aborted || !runtime.board.canEdit) return [];
      assets.push(await uploadBoardImage(runtime.session.board.id, file, signal));
    }
    if (signal.aborted || !runtime.board.canEdit) return [];
    return runtime.board.insert(assets.map((asset, index) => {
      const ratio = Math.min(1, 600 / Math.max(asset.width, asset.height));
      return { type: LayerType.Image, x: position.x + index * 32, y: position.y + index * 32,
        width: asset.width * ratio, height: asset.height * ratio, src: asset.url };
    }));
  }, "Не удалось вставить изображения"), [runtime, runInsertion]);
  const insertImage = useCallback((file: File) => insertImages([file]), [insertImages]);
  const insertLayers = useCallback((clipboard: BoardClipboard) => runInsertion(
    (signal) => insertBoardClipboard(runtime.session.board.id, runtime.board, clipboard, signal),
    "Не удалось вставить данные",
  ), [runtime, runInsertion]);

  const duplicate = useCallback(() => {
    const snapshot = runtime.board.getSnapshot();
    const selection = new Set(runtime.getSelf().presence.selection);
    const selected = snapshot.layerIds.filter((id) => selection.has(id));
    const layers = selected.map((id) => snapshot.layers.get(id)!);
    const richText = selected.map((id) => {
      const layer = snapshot.layers.get(id);
      return layer?.type === LayerType.Text || layer?.type === LayerType.Sticker ? runtime.board.getRichText(id) : null;
    });
    void insertLayers({ layers: layers.map((layer) => ({ ...layer, x: layer.x + 32, y: layer.y + 32 })), richText });
  }, [runtime, insertLayers]);

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
          void insertLayers({ layers: offsetLayers(copied.layers, position.x + padding, position.y + padding), richText: copied.richText });
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
        const images = files.map((item) => item.getAsFile()).filter((file): file is File => file !== null);
        if (images.length) void insertImages(images);
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
          KeyL: () => setCanvasState({ mode: BoardCanvasMode.Inserting, layerType: LayerType.Line, lineKind: "segment" }),
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
  }, [runtime, color, cancel, setCanvasState, duplicate, insertImages, insertLayers]);

  return { insertImage };
}
