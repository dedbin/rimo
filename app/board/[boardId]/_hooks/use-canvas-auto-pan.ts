"use client";

import { useEffect, useRef } from "react";
import type { RefObject } from "react";

import { edgePanVelocity, outsidePanVelocity, stepEdgePan } from "@/lib/board/auto-pan";
import type { CanvasPointerSample } from "@/lib/board/pointer-sample";
import { useEvent } from "@/lib/collaboration/use-event";
import type { Camera, Point } from "@/types/board-canvas";

interface Options {
  svgRef: RefObject<SVGSVGElement | null>;
  cameraRef: RefObject<Camera>;
  enabled: boolean;
  blocked: boolean;
  canPan: (sample: CanvasPointerSample) => boolean;
  updateCamera: (camera: Camera) => void;
  onCameraMoved: (sample: CanvasPointerSample) => void;
  onPointerExit?: (sample: CanvasPointerSample) => void;
}

const TEXT_INPUT = 'input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"]';
const INTERACTIVE = `${TEXT_INPUT}, a[href], button, [role="button"], [data-graph-interaction="true"]`;
const MODAL = '[role="dialog"][data-state="open"], [role="alertdialog"][data-state="open"], [role="menu"][data-state="open"], dialog[open]';
const CLICK_PAUSE_MS = 500;

function snapshot(event: PointerEvent): CanvasPointerSample {
  return { pointerId: event.pointerId, pointerType: event.pointerType, clientX: event.clientX,
    clientY: event.clientY, pressure: event.pressure, buttons: event.buttons, shiftKey: event.shiftKey };
}

function outsideBounds(sample: CanvasPointerSample, rect: DOMRect): boolean {
  return sample.clientX < rect.left || sample.clientX >= rect.left + rect.width ||
    sample.clientY < rect.top || sample.clientY >= rect.top + rect.height;
}

export function useCanvasAutoPan({ svgRef, cameraRef, enabled, blocked, canPan, updateCamera, onCameraMoved, onPointerExit }: Options) {
  const pointer = useRef<CanvasPointerSample | null>(null);
  const outside = useRef<Point | null>(null);
  const frame = useRef<number | null>(null);
  const lastTime = useRef<number | null>(null);
  const spacePressed = useRef(false);
  const clickPauseUntil = useRef(0);
  const isPanAllowed = useEvent(canPan);
  const notifyExit = useEvent((sample: CanvasPointerSample) => onPointerExit?.(sample));

  const pause = useEvent(() => {
    if (frame.current !== null) cancelAnimationFrame(frame.current);
    frame.current = null;
    lastTime.current = null;
  });
  const reset = useEvent(() => { pause(); pointer.current = null; outside.current = null; clickPauseUntil.current = 0; });
  const eligible = useEvent((sample: CanvasPointerSample): boolean => {
    const svg = svgRef.current;
    return enabled && !blocked && !spacePressed.current && !document.hidden && document.hasFocus() && !!svg &&
      (sample.buttons & ~1) === 0 && !document.querySelector(MODAL) && !document.activeElement?.closest(TEXT_INPUT);
  });
  const overCanvas = useEvent((sample: CanvasPointerSample): boolean => {
    const target = document.elementFromPoint(sample.clientX, sample.clientY);
    return !!target && !!svgRef.current?.contains(target) && !target.closest(INTERACTIVE);
  });

  const tick = useEvent((time: number) => {
    frame.current = null;
    const sample = pointer.current;
    const svg = svgRef.current;
    if (!sample || !svg || !eligible(sample) || (!outside.current && !overCanvas(sample))) { reset(); return; }
    if (!isPanAllowed(sample)) { pause(); return; }
    if (time < clickPauseUntil.current) {
      lastTime.current = null;
      frame.current = requestAnimationFrame(tick);
      return;
    }
    const velocity = outside.current ?? edgePanVelocity({ x: sample.clientX, y: sample.clientY }, svg.getBoundingClientRect());
    if (!velocity.x && !velocity.y) { pause(); return; }
    const elapsed = lastTime.current === null ? 0 : time - lastTime.current;
    lastTime.current = time;
    if (elapsed > 0 && cameraRef.current) {
      updateCamera(stepEdgePan(cameraRef.current, velocity, elapsed));
      // A departed hovering mouse has no board cursor. Only a captured editing
      // gesture needs its raw pointer coordinates refreshed outside the window.
      if (!outside.current || (sample.buttons === 1 && svg.hasPointerCapture(sample.pointerId))) onCameraMoved(sample);
    }
    frame.current = requestAnimationFrame(tick);
  });
  const schedule = useEvent(() => {
    if (frame.current === null) frame.current = requestAnimationFrame(tick);
  });

  useEffect(() => { reset(); }, [enabled, blocked, reset]);
  useEffect(() => {
    const canvasOrigin = (event: PointerEvent): boolean =>
      event.target instanceof Element && !!svgRef.current?.contains(event.target) && !event.target.closest(INTERACTIVE);
    const record = (sample: CanvasPointerSample, isOutside: boolean) => {
      pointer.current = sample;
      outside.current = isOutside && svgRef.current
        ? outsidePanVelocity({ x: sample.clientX, y: sample.clientY }, svgRef.current.getBoundingClientRect()) : null;
      schedule();
    };
    const move = (event: PointerEvent) => {
      if (event.pointerType !== "mouse") { reset(); return; }
      const sample = snapshot(event);
      const svg = svgRef.current;
      if (!svg || !eligible(sample)) { reset(); return; }
      const isOutside = outsideBounds(sample, svg.getBoundingClientRect());
      if (isOutside ? !canvasOrigin(event) && !outside.current : !overCanvas(sample)) { reset(); return; }
      clickPauseUntil.current = 0;
      record(sample, isOutside);
    };
    const button = (event: PointerEvent) => {
      if (event.pointerType !== "mouse") { reset(); return; }
      if (pointer.current?.pointerId !== event.pointerId) return;
      const sample = snapshot(event);
      const svg = svgRef.current;
      if (!svg || !eligible(sample)) { reset(); return; }
      const isOutside = outsideBounds(sample, svg.getBoundingClientRect());
      if (isOutside ? !outside.current && !canvasOrigin(event) : !overCanvas(sample)) { reset(); return; }
      // Leave a clicked object still long enough for a second click. Real
      // strokes/drags keep their immediate pointerup-to-hover continuation.
      if (event.type === "pointerup" && !isPanAllowed(sample)) clickPauseUntil.current = performance.now() + CLICK_PAUSE_MS;
      record(sample, isOutside);
    };
    const lostCapture = (event: PointerEvent) => {
      if (pointer.current?.pointerId === event.pointerId && pointer.current.buttons !== 0 &&
        !svgRef.current?.hasPointerCapture(event.pointerId)) reset();
    };
    const leave = (event: PointerEvent) => {
      if (event.relatedTarget !== null) return;
      if (event.pointerType !== "mouse") { reset(); return; }
      if (pointer.current && pointer.current.pointerId !== event.pointerId) return;
      const sample = snapshot(event);
      if (!canvasOrigin(event) || !eligible(sample)) { reset(); return; }
      // Crossing the window boundary is enough intent; no edge dwell or
      // last-pixel hit is required, even after a fast movement from the center.
      clickPauseUntil.current = 0;
      if (sample.buttons === 1 && isPanAllowed(sample) && !svgRef.current?.hasPointerCapture(sample.pointerId)) notifyExit(sample);
      record(sample, true);
    };
    const visibility = () => { if (document.hidden) { spacePressed.current = false; reset(); } };
    const blur = () => { spacePressed.current = false; reset(); };
    const keydown = (event: KeyboardEvent) => {
      if (pointer.current) pointer.current = { ...pointer.current, shiftKey: event.shiftKey };
      if (event.code === "Space" || event.key === " ") spacePressed.current = true;
      if (spacePressed.current || event.key === "Escape") reset();
    };
    const keyup = (event: KeyboardEvent) => {
      if (pointer.current) pointer.current = { ...pointer.current, shiftKey: event.shiftKey };
      if (event.code === "Space" || event.key === " ") spacePressed.current = false;
    };
    document.addEventListener("pointermove", move, true);
    document.addEventListener("pointerdown", button, true);
    document.addEventListener("pointerup", button, true);
    document.addEventListener("pointercancel", reset, true);
    document.addEventListener("lostpointercapture", lostCapture, true);
    document.addEventListener("pointerout", leave, true);
    document.addEventListener("wheel", reset, true);
    document.addEventListener("keydown", keydown, true);
    document.addEventListener("keyup", keyup, true);
    document.addEventListener("visibilitychange", visibility);
    window.addEventListener("blur", blur);
    return () => {
      document.removeEventListener("pointermove", move, true);
      document.removeEventListener("pointerdown", button, true);
      document.removeEventListener("pointerup", button, true);
      document.removeEventListener("pointercancel", reset, true);
      document.removeEventListener("lostpointercapture", lostCapture, true);
      document.removeEventListener("pointerout", leave, true);
      document.removeEventListener("wheel", reset, true);
      document.removeEventListener("keydown", keydown, true);
      document.removeEventListener("keyup", keyup, true);
      document.removeEventListener("visibilitychange", visibility);
      window.removeEventListener("blur", blur);
      reset();
    };
  }, [svgRef, eligible, overCanvas, reset, schedule, isPanAllowed, notifyExit]);

  return { reset };
}
