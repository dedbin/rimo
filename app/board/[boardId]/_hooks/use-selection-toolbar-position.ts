"use client";

import { useLayoutEffect, useRef, useState } from "react";
import type { Camera, XYWH } from "@/types/board-canvas";

export function useSelectionToolbarPosition(bounds: XYWH | null, camera: Camera) {
  const ref = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ left: 8, top: 72 });

  useLayoutEffect(() => {
    const toolbar = ref.current;
    if (!toolbar || !bounds) return;
    const place = () => {
      const { width, height } = toolbar.getBoundingClientRect();
      const parent = toolbar.offsetParent?.getBoundingClientRect();
      const parentX = parent?.left ?? 0;
      const parentY = parent?.top ?? 0;
      const center = (bounds.x + bounds.width / 2) * camera.scale + camera.x + parentX;
      const above = bounds.y * camera.scale + camera.y + parentY - height - 12;
      const below = (bounds.y + bounds.height) * camera.scale + camera.y + parentY + 12;
      const left = Math.max(8, Math.min(center - width / 2, window.innerWidth - width - 8)) - parentX;
      const top = Math.max(72, Math.min(above >= 72 ? above : below, window.innerHeight - height - 16)) - parentY;
      setPosition((current) => current.left === left && current.top === top ? current : { left, top });
    };
    place();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(place);
    observer?.observe(toolbar);
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => { observer?.disconnect(); window.removeEventListener("resize", place); window.removeEventListener("scroll", place, true); };
  }, [bounds, camera]);

  return { ref, position };
}
