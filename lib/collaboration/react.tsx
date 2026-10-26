"use client";

import { createContext, useContext, useSyncExternalStore } from "react";
import { BoardRuntime } from "./runtime";

export const BoardRuntimeContext = createContext<BoardRuntime | null>(null);

export function useBoardRuntime(): BoardRuntime {
  const runtime = useContext(BoardRuntimeContext);
  if (!runtime) throw new Error("Редактор должен находиться внутри комнаты доски");
  return runtime;
}

export function useBoardSnapshot() {
  const { board } = useBoardRuntime();
  return useSyncExternalStore(board.subscribe, board.getSnapshot, board.getSnapshot);
}

export function useLayer(id: string) {
  const { board } = useBoardRuntime();
  return useSyncExternalStore(board.subscribe, () => board.getLayer(id), () => board.getLayer(id));
}

export function useSelection() {
  const runtime = useBoardRuntime();
  return useSyncExternalStore(runtime.subscribePresence,
    () => runtime.getSelf().presence.selection, () => runtime.getSelf().presence.selection);
}

export function useSelf() {
  const runtime = useBoardRuntime();
  return useSyncExternalStore(runtime.subscribePresence, runtime.getSelf, runtime.getSelf);
}

export function usePencilDraft() {
  const runtime = useBoardRuntime();
  return useSyncExternalStore(runtime.subscribePresence,
    () => runtime.getSelf().presence.pencilDraft, () => runtime.getSelf().presence.pencilDraft);
}

export function useOthers() {
  const runtime = useBoardRuntime();
  return useSyncExternalStore(runtime.subscribePresence, runtime.getOthers, runtime.getOthers);
}

export function useConnectionState() {
  const runtime = useBoardRuntime();
  return useSyncExternalStore(runtime.subscribeState, runtime.getState, runtime.getState);
}

export function useBoardHistory() {
  const { board } = useBoardRuntime();
  const manager = board.undoManager;
  const subscribe = (callback: () => void) => {
    manager.on("stack-item-added", callback);
    manager.on("stack-item-popped", callback);
    manager.on("stack-cleared", callback);
    return () => {
      manager.off("stack-item-added", callback);
      manager.off("stack-item-popped", callback);
      manager.off("stack-cleared", callback);
    };
  };
  const canUndo = useSyncExternalStore(subscribe, () => manager.undoStack.length > 0, () => false);
  const canRedo = useSyncExternalStore(subscribe, () => manager.redoStack.length > 0, () => false);
  return { undo: board.undo, redo: board.redo, canUndo, canRedo };
}
