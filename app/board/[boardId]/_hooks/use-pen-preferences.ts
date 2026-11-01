"use client";

import { useCallback, useEffect, useState } from "react";

import { defaultPenPreferences, parsePenPreferences, penPreferencesKey, PEN_SIZES, validPenColor } from "@/lib/board/pen-preferences";
import type { PenPreferences } from "@/lib/board/pen-preferences";
import type { Color } from "@/types/board-canvas";

interface PersonalPenState extends PenPreferences {
  readonly userId: string;
  readonly loaded: boolean;
}

interface PersonalPenPreferences extends PenPreferences {
  readonly setColor: (color: Color) => void;
  readonly setSize: (size: number) => void;
}

function readPreferences(userId: string): PenPreferences {
  if (!userId || typeof window === "undefined") return defaultPenPreferences();
  try { return parsePenPreferences(window.localStorage.getItem(penPreferencesKey(userId))); }
  catch { return defaultPenPreferences(); }
}

export function usePenPreferences(userId: string): PersonalPenPreferences {
  // The first client render matches SSR. Browser settings are read after hydration.
  const [state, setState] = useState<PersonalPenState>(() => ({ userId, loaded: false, ...defaultPenPreferences() }));

  useEffect(() => {
    setState({ userId, loaded: true, ...readPreferences(userId) });
  }, [userId]);

  useEffect(() => {
    if (!userId || !state.loaded || state.userId !== userId) return;
    try {
      window.localStorage.setItem(penPreferencesKey(userId), JSON.stringify({ version: 1, color: state.color, size: state.size }));
    } catch {
      // Drawing still works when the browser denies storage or its quota is full.
    }
  }, [state, userId]);

  const setColor = useCallback((color: Color): void => {
    const next = validPenColor(color);
    if (!next) return;
    setState((previous) => {
      const preferences = previous.userId === userId ? previous : defaultPenPreferences();
      return {
        ...preferences, userId, loaded: true,
        color: { ...next, ...(next.a === undefined && preferences.color.a !== undefined ? { a: preferences.color.a } : {}) },
      };
    });
  }, [userId]);

  const setSize = useCallback((size: number): void => {
    if (!PEN_SIZES.includes(size)) return;
    setState((previous) => ({
      ...(previous.userId === userId ? previous : defaultPenPreferences()),
      userId, loaded: true, size,
    }));
  }, [userId]);

  // Do not expose the previous account's settings during an account transition.
  const preferences = state.userId === userId ? state : defaultPenPreferences();
  return { color: preferences.color, size: preferences.size, setColor, setSize };
}
