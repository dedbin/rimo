"use client";

import { useEffect, useRef, useState, type PointerEvent } from "react";

import { useBoardRuntime } from "@/lib/collaboration/react";
import { useEvent } from "@/lib/collaboration/use-event";
import { panGraphViewport, zoomGraphViewport } from "@/lib/board/graph/navigation";
import type { GraphViewport, Point } from "@/types/board-canvas";

interface Baseline {
  viewport: GraphViewport;
  points: Point[];
}

export function useGraphNavigation(id: string, viewport: GraphViewport, enabled: boolean) {
  const { board } = useBoardRuntime();
  const ref = useRef<HTMLDivElement | null>(null);
  const [draft, setDraft] = useState<GraphViewport | null>(null);
  const current = useRef(viewport);
  current.current = draft ?? viewport;
  const contacts = useRef(new Map<number, Point>());
  const baseline = useRef<Baseline | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const animation = useRef<number | null>(null);
  const pending = useRef<GraphViewport | null>(null);

  const cancel = useEvent(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    if (animation.current !== null) cancelAnimationFrame(animation.current);
    animation.current = null;
    const captured = [...contacts.current.keys()];
    contacts.current.clear();
    baseline.current = null;
    pending.current = null;
    current.current = viewport;
    setDraft(null);
    for (const pointerId of captured) if (ref.current?.hasPointerCapture(pointerId)) ref.current.releasePointerCapture(pointerId);
  });

  const commit = useEvent(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    if (animation.current !== null) cancelAnimationFrame(animation.current);
    animation.current = null;
    const next = pending.current ?? current.current;
    pending.current = null;
    if (enabled && board.canEdit) board.updateGraphSettings(id, { viewport: next });
    setDraft(null);
  });
  const preview = (next: GraphViewport): void => {
    current.current = next;
    pending.current = next;
    if (animation.current !== null) return;
    animation.current = requestAnimationFrame(() => {
      animation.current = null;
      setDraft(pending.current);
    });
  };
  const begin = (): void => {
    baseline.current = { viewport: { ...current.current }, points: [...contacts.current.values()] };
  };
  const position = (event: { clientX: number; clientY: number }): Point => {
    const box = ref.current!.getBoundingClientRect();
    return { x: (event.clientX - box.left) / box.width, y: (event.clientY - box.top) / box.height };
  };
  const pointerDown = (event: PointerEvent<HTMLDivElement>): void => {
    if (!enabled || !board.canEdit || (event.button !== 0 && event.pointerType !== "touch")) return;
    event.preventDefault();
    event.stopPropagation();
    ref.current?.setPointerCapture(event.pointerId);
    contacts.current.set(event.pointerId, position(event));
    begin();
  };
  const pointerMove = (event: PointerEvent<HTMLDivElement>): void => {
    if (!enabled || !contacts.current.has(event.pointerId) || !baseline.current) return;
    if (event.pointerType !== "touch" && event.buttons === 0) { cancel(); return; }
    event.preventDefault();
    event.stopPropagation();
    contacts.current.set(event.pointerId, position(event));
    const points = [...contacts.current.values()];
    const initial = baseline.current;
    if (points.length >= 2 && initial.points.length >= 2) {
      const midpoint = (items: Point[]): Point => ({ x: (items[0].x + items[1].x) / 2, y: (items[0].y + items[1].y) / 2 });
      const distance = (items: Point[]): number => Math.hypot(items[1].x - items[0].x, items[1].y - items[0].y);
      const origin = midpoint(initial.points);
      const currentPoint = midpoint(points);
      const factor = Math.max(0.02, Math.min(50, distance(initial.points) / Math.max(0.001, distance(points))));
      const zoomed = zoomGraphViewport(initial.viewport, factor, origin.x, origin.y);
      preview(panGraphViewport(zoomed, currentPoint.x - origin.x, currentPoint.y - origin.y));
    } else preview(panGraphViewport(initial.viewport, points[0].x - initial.points[0].x, points[0].y - initial.points[0].y));
  };
  const finish = (event: PointerEvent<HTMLDivElement>): void => {
    if (!enabled || !contacts.current.has(event.pointerId)) return;
    event.stopPropagation();
    contacts.current.delete(event.pointerId);
    if (ref.current?.hasPointerCapture(event.pointerId)) ref.current.releasePointerCapture(event.pointerId);
    if (contacts.current.size) begin();
    else { baseline.current = null; commit(); }
  };
  const wheel = useEvent((event: WheelEvent) => {
    if (!enabled || !board.canEdit) return;
    event.preventDefault();
    event.stopPropagation();
    const point = position(event);
    preview(zoomGraphViewport(current.current, Math.exp(Math.max(-0.5, Math.min(0.5, event.deltaY * 0.002))), point.x, point.y));
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(commit, 180);
  });

  useEffect(() => {
    const element = ref.current;
    element?.addEventListener("wheel", wheel, { passive: false });
    return () => element?.removeEventListener("wheel", wheel);
  }, [wheel]);
  useEffect(() => {
    window.addEventListener("blur", cancel);
    return () => window.removeEventListener("blur", cancel);
  }, [cancel]);
  useEffect(() => {
    if (enabled) return;
    if (pending.current && board.canEdit) board.updateGraphSettings(id, { viewport: pending.current });
    for (const pointerId of contacts.current.keys()) {
      if (ref.current?.hasPointerCapture(pointerId)) ref.current.releasePointerCapture(pointerId);
    }
    contacts.current.clear();
    baseline.current = null;
    pending.current = null;
    setDraft(null);
  }, [enabled, board, id]);
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
    if (animation.current !== null) cancelAnimationFrame(animation.current);
    contacts.current.clear();
  }, []);
  return { ref, viewport: draft ?? viewport, pointerDown, pointerMove, finish, cancel,
    lostCapture: (event: PointerEvent<HTMLDivElement>) => {
      if (contacts.current.has(event.pointerId)) cancel();
    } };
}
