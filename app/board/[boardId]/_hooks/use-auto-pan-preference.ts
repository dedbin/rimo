"use client";

import { useCallback, useEffect, useState } from "react";

const STORAGE_KEY = "rimo:auto-pan:v1";

interface AutoPanPreference {
  readonly enabled: boolean;
  readonly loaded: boolean;
  readonly setEnabled: (enabled: boolean) => void;
}

function readEnabled(): boolean {
  try { return window.localStorage.getItem(STORAGE_KEY) !== "false"; }
  catch { return true; }
}

export function useAutoPanPreference(): AutoPanPreference {
  // Keep the first client render identical to SSR before reading browser settings.
  const [state, setState] = useState({ enabled: true, loaded: false });

  useEffect(() => {
    setState({ enabled: readEnabled(), loaded: true });
  }, []);

  const setEnabled = useCallback((enabled: boolean): void => {
    setState({ enabled, loaded: true });
    try { window.localStorage.setItem(STORAGE_KEY, String(enabled)); }
    catch {
      // The switch remains usable when storage is denied or its quota is full.
    }
  }, []);

  return { ...state, setEnabled };
}
