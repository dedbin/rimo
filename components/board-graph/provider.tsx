"use client";

import { createContext, useCallback, useContext, useMemo, useState } from "react";
import type { ReactNode } from "react";

interface GraphEditorController {
  readonly editingId: string | null;
  readonly navigationId: string | null;
  open: (id: string) => void;
  close: () => void;
  setNavigation: (id: string | null) => void;
}

const GraphEditorContext = createContext<GraphEditorController | null>(null);
const INACTIVE_EDITOR: GraphEditorController = {
  editingId: null, navigationId: null,
  open: () => undefined, close: () => undefined, setNavigation: () => undefined,
};

export function GraphEditorProvider({ children }: { children: ReactNode }) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [navigationId, setNavigation] = useState<string | null>(null);
  const open = useCallback((id: string) => {
    setEditingId(id);
    setNavigation(null);
  }, []);
  const close = useCallback(() => {
    setEditingId(null);
    setNavigation(null);
  }, []);
  const value = useMemo(() => ({ editingId, navigationId, open, close, setNavigation }),
    [editingId, navigationId, open, close]);

  return <GraphEditorContext.Provider value={value}>{children}</GraphEditorContext.Provider>;
}

export function useGraphEditor(): GraphEditorController {
  return useContext(GraphEditorContext) ?? INACTIVE_EDITOR;
}
