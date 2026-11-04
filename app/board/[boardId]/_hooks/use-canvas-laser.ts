"use client";

import { useEffect, useRef } from "react";
import type { PointerEvent, RefObject } from "react";

import { LASER_LIFETIME_MS, LASER_MAX_POINTS, parseLaserPresence, PRESENTATION_INTERVAL_MS } from "@/lib/collaboration/presentation";
import { useBoardRuntime } from "@/lib/collaboration/react";
import { useEvent } from "@/lib/collaboration/use-event";
import { pointerEventToCanvasPoint } from "@/lib/utils";
import type { Camera, Point } from "@/types/board-canvas";
import type { CanvasPointerSample } from "@/lib/board/pointer-sample";

interface Options {
  active: boolean;
  svgRef: RefObject<SVGSVGElement | null>;
  cameraRef: RefObject<Camera>;
}

export function useCanvasLaser({ active, svgRef, cameraRef }: Options) {
  const runtime = useBoardRuntime();
  const pointer = useRef<{ id: number; type: string } | null>(null);
  const contacts = useRef(new Set<number>());
  const suppressed = useRef(false);
  const points = useRef<Point[]>([]);
  const sequence = useRef(runtime.getSelf().presence.laser?.sequence ?? 0);
  const lastSent = useRef(-Infinity);
  const lastMove = useRef(-Infinity);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clear = useEvent(() => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
    points.current = [];
    const id = pointer.current?.id;
    pointer.current = null;
    if (id !== undefined && svgRef.current?.hasPointerCapture(id)) svgRef.current.releasePointerCapture(id);
    if (runtime.getSelf().presence.laser) runtime.updatePresence({ laser: null });
  });

  const reset = useEvent(() => { clear(); contacts.current.clear(); suppressed.current = false; });
  const publish = useEvent(() => {
    timer.current = null;
    const state = runtime.getState();
    if (!active || !pointer.current || !state.connected || !state.synced || state.error || !points.current.length) return;
    sequence.current = Math.max(sequence.current + 1, Math.ceil(performance.now() * 1000));
    const laser = parseLaserPresence({ sequence: sequence.current, points: points.current });
    if (!laser) { clear(); return; }
    lastSent.current = performance.now();
    runtime.updatePresence({ laser, cursor: null });
  });

  const sample = useEvent((event: Pick<CanvasPointerSample, "clientX" | "clientY">) => {
    const svg = svgRef.current;
    if (!svg || !cameraRef.current) return;
    const now = performance.now();
    if (now - lastMove.current >= LASER_LIFETIME_MS) points.current = [];
    lastMove.current = now;
    const point = pointerEventToCanvasPoint(event.clientX, event.clientY, cameraRef.current, svg);
    const previous = points.current.at(-1);
    if (previous?.x === point.x && previous.y === point.y) return;
    points.current = [...points.current.slice(-(LASER_MAX_POINTS - 1)), point];
    const delay = PRESENTATION_INTERVAL_MS - (now - lastSent.current);
    if (delay <= 0) publish();
    else if (timer.current === null) timer.current = setTimeout(publish, delay);
  });

  const onPointerDown = useEvent((event: PointerEvent<SVGSVGElement>) => {
    if (!active) return;
    if (event.pointerType === "touch") {
      contacts.current.add(event.pointerId);
      if (pointer.current?.type === "pen") return;
      if (contacts.current.size > 1) { suppressed.current = true; clear(); return; }
    }
    if (event.button !== 0 || suppressed.current || (pointer.current && event.pointerType !== "pen")) return;
    const state = runtime.getState();
    if (!state.connected || !state.synced || state.error) return;
    if (pointer.current) clear();
    pointer.current = { id: event.pointerId, type: event.pointerType };
    svgRef.current?.setPointerCapture(event.pointerId);
    event.preventDefault();
    sample(event);
  });
  const refreshPointer = useEvent((event: Pick<CanvasPointerSample, "pointerId" | "clientX" | "clientY">) => {
    if (!active || suppressed.current || pointer.current?.id !== event.pointerId) return;
    sample(event);
  });
  const finish = useEvent((event?: Pick<PointerEvent<SVGSVGElement>, "pointerId">) => {
    if (!event) { reset(); return; }
    contacts.current.delete(event.pointerId);
    if (!contacts.current.size) suppressed.current = false;
    if (pointer.current?.id === event.pointerId) clear();
  });
  const onPointerLeave = useEvent((event?: Pick<PointerEvent<SVGSVGElement>, "pointerId">) => {
    if (!event || pointer.current?.id === event.pointerId) clear();
  });

  useEffect(() => {
    if (!active) reset();
    const visibility = () => { if (document.hidden) reset(); };
    window.addEventListener("blur", reset);
    document.addEventListener("visibilitychange", visibility);
    const unsubscribe = runtime.subscribeState(() => {
      const state = runtime.getState();
      // Clear synchronously before the SDK can flush pending presence on sync.
      if (!state.connected || !state.synced || state.error) reset();
    });
    return () => {
      unsubscribe();
      window.removeEventListener("blur", reset);
      document.removeEventListener("visibilitychange", visibility);
      reset();
    };
  }, [active, runtime, reset]);

  return { onPointerDown, onPointerMove: refreshPointer, refreshPointer, onPointerUp: finish, onPointerCancel: finish, onPointerLeave, clear };
}
