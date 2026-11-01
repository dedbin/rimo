"use client";

import { useMemo, useRef, type RefObject } from "react";

import { useEvent } from "@/lib/collaboration/use-event";
import type { Camera, Point } from "@/types/board-canvas";

interface TouchPointer {
  pointerId: number;
  pointerType: string;
  clientX: number;
  clientY: number;
  preventDefault: () => void;
  stopPropagation: () => void;
}

interface Pinch {
  ids: readonly [number, number];
  camera: Camera;
  midpoint: Point;
  distance: number;
}

interface Options {
  svgRef: RefObject<SVGSVGElement | null>;
  cameraRef: RefObject<Camera>;
  updateCamera: (camera: Camera) => void;
  onNavigate: () => void;
}

export function useCanvasTouch({ svgRef, cameraRef, updateCamera, onNavigate }: Options) {
  const contacts = useRef(new Map<number, Point>());
  const pens = useRef(new Set<number>());
  const mode = useRef<"navigate" | "ignore" | null>(null);
  const pinch = useRef<Pinch | null>(null);

  const position = (event: TouchPointer): Point => {
    const rect = svgRef.current?.getBoundingClientRect();
    return { x: event.clientX - (rect?.left ?? 0), y: event.clientY - (rect?.top ?? 0) };
  };
  const baseline = () => {
    const points = [...contacts.current.entries()];
    if (points.length < 2) { pinch.current = null; return; }
    const [[firstId, first], [secondId, second]] = points;
    pinch.current = { ids: [firstId, secondId], camera: { ...cameraRef.current! },
      midpoint: { x: (first.x + second.x) / 2, y: (first.y + second.y) / 2 },
      distance: Math.max(1, Math.hypot(second.x - first.x, second.y - first.y)) };
  };
  const suppress = (event: TouchPointer) => { event.preventDefault(); event.stopPropagation(); };
  const blocks = useEvent((event: Pick<TouchPointer, "pointerType">) => event.pointerType === "touch"
    ? mode.current !== null
    : event.pointerType !== "pen" && contacts.current.size > 0);

  const onPointerDownCapture = useEvent((event: TouchPointer, activePointerType?: string) => {
    if (event.pointerType === "pen") {
      pens.current.add(event.pointerId);
      if (contacts.current.size && (!activePointerType || activePointerType === "touch")) {
        mode.current = "ignore";
        pinch.current = null;
        onNavigate();
      }
      return;
    }
    if (event.pointerType !== "touch" || contacts.current.has(event.pointerId)) return;
    contacts.current.set(event.pointerId, position(event));
    if (pens.current.size || (activePointerType && activePointerType !== "touch")) mode.current = "ignore";
    if (mode.current === "ignore") { suppress(event); return; }
    if (contacts.current.size < 2) return;
    if (mode.current === null) {
      mode.current = "navigate";
      onNavigate();
      // A manual gesture also stops a fit/zoom animation before its first move.
      updateCamera({ ...cameraRef.current! });
    }
    if (!pinch.current) baseline();
    for (const id of contacts.current.keys()) svgRef.current?.setPointerCapture(id);
    suppress(event);
  });

  const onPointerMove = useEvent((event: TouchPointer): boolean => {
    if (!contacts.current.has(event.pointerId)) return false;
    contacts.current.set(event.pointerId, position(event));
    if (mode.current === null) return false;
    const initial = pinch.current;
    if (mode.current === "navigate" && initial) {
      const first = contacts.current.get(initial.ids[0]);
      const second = contacts.current.get(initial.ids[1]);
      if (first && second) {
        const midpoint = { x: (first.x + second.x) / 2, y: (first.y + second.y) / 2 };
        const distance = Math.hypot(second.x - first.x, second.y - first.y);
        const scale = Math.max(0.1, Math.min(4, initial.camera.scale * distance / initial.distance));
        updateCamera({ scale,
          x: midpoint.x - (initial.midpoint.x - initial.camera.x) / initial.camera.scale * scale,
          y: midpoint.y - (initial.midpoint.y - initial.camera.y) / initial.camera.scale * scale });
      }
    }
    event.preventDefault();
    return true;
  });

  const finish = useEvent((event: Pick<TouchPointer, "pointerId">): boolean => {
    pens.current.delete(event.pointerId);
    const consumed = contacts.current.has(event.pointerId) && mode.current !== null;
    contacts.current.delete(event.pointerId);
    if (!contacts.current.size) { mode.current = null; pinch.current = null; }
    else if (pinch.current?.ids.includes(event.pointerId)) baseline();
    if (consumed && svgRef.current?.hasPointerCapture(event.pointerId)) svgRef.current.releasePointerCapture(event.pointerId);
    return consumed;
  });
  const cancelNavigation = useEvent(() => {
    pinch.current = null;
    mode.current = contacts.current.size ? "ignore" : null;
  });
  const reset = useEvent(() => {
    const ids = [...contacts.current.keys()];
    contacts.current.clear();
    pens.current.clear();
    mode.current = null;
    pinch.current = null;
    for (const id of ids) if (svgRef.current?.hasPointerCapture(id)) svgRef.current.releasePointerCapture(id);
  });

  const owns = useEvent((pointerId: number) => contacts.current.has(pointerId));
  return useMemo(() => ({ blocks, onPointerDownCapture, onPointerMove, finish, cancelNavigation, reset, owns }),
    [blocks, onPointerDownCapture, onPointerMove, finish, cancelNavigation, reset, owns]);
}
