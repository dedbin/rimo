"use client";

import { RefObject, useEffect } from "react";
import { useEvent } from "@/lib/collaboration/use-event";

export function useContentHeight(element: RefObject<HTMLElement | null>, onHeight: (height: number) => void): void {
  const notify = useEvent(onHeight);
  useEffect(() => {
    const content = element.current;
    if (!content) return;
    let frame: number | null = null;
    let disposed = false;
    const measure = () => {
      if (disposed) return;
      if (frame !== null) cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        frame = null;
        // offset/scroll height are unscaled by the board camera, unlike boundingClientRect.
        notify(Math.ceil(Math.max(content.scrollHeight, content.offsetHeight)));
      });
    };
    const observer = typeof ResizeObserver !== "undefined" ? new ResizeObserver(measure) : null;
    observer?.observe(content);
    void document.fonts?.ready.then(measure);
    measure();
    return () => { disposed = true; observer?.disconnect(); if (frame !== null) cancelAnimationFrame(frame); };
  }, [element, notify]);
}
