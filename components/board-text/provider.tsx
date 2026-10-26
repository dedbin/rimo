"use client";

import { createContext, ReactNode, useCallback, useContext, useEffect, useRef, useState } from "react";
import { Editor } from "@tiptap/core";
import { absolutePositionToRelativePosition, SyncPluginState, ySyncPluginKey } from "@tiptap/y-tiptap";
import { RelativePosition } from "yjs";
import { useBoardRuntime, useConnectionState } from "@/lib/collaboration/react";
import { LayerType } from "@/types/board-canvas";

export interface MathRequest {
  type: "inlineMath" | "blockMath";
  latex: string;
  anchor: RelativePosition | null;
}
interface TextController {
  activeId: string | null;
  editor: Editor | null;
  activate: (id: string) => void;
  deactivate: () => void;
  register: (id: string, editor: Editor | null) => void;
  math: MathRequest | null;
  openMath: (type: MathRequest["type"], position?: number, latex?: string) => void;
  closeMath: () => void;
}
const TextContext = createContext<TextController | null>(null);

export function BoardTextProvider({ children }: { children: ReactNode }) {
  const runtime = useBoardRuntime();
  const connection = useConnectionState();
  const [activeId, setActiveId] = useState<string | null>(null);
  const [registered, setRegistered] = useState<{ id: string; editor: Editor } | null>(null);
  const [math, setMath] = useState<MathRequest | null>(null);
  const editor = registered?.id === activeId ? registered.editor : null;
  const editorRef = useRef(editor);
  editorRef.current = editor;
  const deactivate = useCallback(() => {
    runtime.board.undoManager.stopCapturing();
    editorRef.current?.commands.blur();
    setActiveId(null);
    setMath(null);
  }, [runtime]);
  const activate = useCallback((id: string) => {
    const layer = runtime.board.getLayer(id);
    if (!runtime.board.canEdit || (layer?.type !== LayerType.Text && layer?.type !== LayerType.Sticker)) return;
    runtime.board.undoManager.stopCapturing();
    runtime.updatePresence({ selection: [id] });
    setActiveId(id);
  }, [runtime]);
  const register = useCallback((id: string, next: Editor | null) => {
    setRegistered((current) => next ? { id, editor: next } : current?.id === id ? null : current);
  }, []);
  useEffect(() => {
    if (!activeId) return;
    const outside = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      if (target.closest(`[data-board-text-id="${activeId}"]`) || target.closest("[data-board-text-toolbar],[data-board-text-dialog]")) return;
      deactivate();
    };
    document.addEventListener("pointerdown", outside, true);
    return () => document.removeEventListener("pointerdown", outside, true);
  }, [activeId, deactivate]);
  useEffect(() => {
    if (!runtime.board.canEdit && activeId) deactivate();
  }, [runtime, connection, activeId, deactivate]);
  const openMath = useCallback((type: MathRequest["type"], position?: number, latex = "") => {
    const current = editorRef.current;
    if (!current) return;
    const sync = ySyncPluginKey.getState(current.state) as SyncPluginState | undefined;
    const anchor = position !== undefined && sync
      ? absolutePositionToRelativePosition(position, sync.type, sync.binding.mapping) : null;
    setMath({ type, latex, anchor });
  }, []);
  return <TextContext.Provider value={{ activeId, editor, activate, deactivate, register, math,
    openMath, closeMath: () => setMath(null) }}>{children}</TextContext.Provider>;
}

export function useBoardText(): TextController {
  const controller = useContext(TextContext);
  if (!controller) throw new Error("Текстовый редактор должен находиться внутри BoardTextProvider");
  return controller;
}
