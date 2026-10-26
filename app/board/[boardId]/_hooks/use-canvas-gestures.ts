"use client";

import { PointerEvent, RefObject, useCallback, useEffect, useRef, useState } from "react";
import { useBoardRuntime } from "@/lib/collaboration/react";
import { useEvent } from "@/lib/collaboration/use-event";
import { getBounds, isInsideBounds } from "@/lib/board/geometry";
import { createLayer } from "@/lib/board/model";
import { doesPointIntersectPath, isPointNearBoundingBox, makePathLayer, pickLayersInBox, pointerEventToCanvasPoint, resizeBounds } from "@/lib/utils";
import { BoardCanvasMode, BoardCanvasState, Camera, Color, LayerType, Point, side, XYWH } from "@/types/board-canvas";
import { toast } from "sonner";

interface PointerSample { clientX: number; clientY: number; pressure: number; buttons: number }
interface ActiveGesture {
  pointerId: number;
  origin: Point;
  ids: string[];
  delta: Point;
  draft: number[][];
  erase: Set<string>;
  initialBounds: XYWH | null;
  resize: XYWH | null;
  corner: side | null;
  screen: Point;
}
export interface GesturePreview {
  ids: readonly string[];
  delta: Point;
  resize: XYWH | null;
  erased: ReadonlySet<string>;
}
const emptyPreview = (): GesturePreview => ({ ids: [], delta: { x: 0, y: 0 }, resize: null, erased: new Set() });

interface Options {
  svgRef: RefObject<SVGSVGElement | null>;
  cameraRef: RefObject<Camera>;
  updateCamera: (camera: Camera) => void;
  color: Color;
  penSize: number;
}

export function useCanvasGestures({ svgRef, cameraRef, updateCamera, color, penSize }: Options) {
  const runtime = useBoardRuntime();
  const [canvasState, setCanvasStateValue] = useState<BoardCanvasState>({ mode: BoardCanvasMode.None });
  const state = useRef(canvasState);
  const [preview, setPreview] = useState<GesturePreview>(emptyPreview);
  const active = useRef<ActiveGesture | null>(null);
  const frame = useRef<number | null>(null);
  const latest = useRef<PointerSample | null>(null);
  const lastPresence = useRef(0);
  const setCanvasState = useCallback((next: BoardCanvasState) => {
    state.current = next;
    setCanvasStateValue(next);
  }, []);
  const toPoint = useCallback((sample: PointerSample) => pointerEventToCanvasPoint(
    sample.clientX, sample.clientY, cameraRef.current!, svgRef.current!,
  ), [cameraRef, svgRef]);

  const publishPreview = (gesture: ActiveGesture) => {
    setPreview({ ids: gesture.ids, delta: { ...gesture.delta }, resize: gesture.resize, erased: new Set(gesture.erase) });
  };

  const processMove = (sample: PointerSample) => {
    if (!svgRef.current) return;
    const point = toPoint(sample);
    const gesture = active.current;
    const mode = state.current.mode;
    if (gesture && mode === BoardCanvasMode.Panning) {
      const current = cameraRef.current!;
      updateCamera({ ...current, x: current.x + sample.clientX - gesture.screen.x,
        y: current.y + sample.clientY - gesture.screen.y });
      gesture.screen = { x: sample.clientX, y: sample.clientY };
    } else if (gesture && mode === BoardCanvasMode.Translating) {
      const delta = { x: point.x - gesture.origin.x, y: point.y - gesture.origin.y };
      if (Math.hypot(delta.x, delta.y) * cameraRef.current!.scale >= 3 || svgRef.current.hasPointerCapture(gesture.pointerId)) {
        gesture.delta = delta;
        publishPreview(gesture);
      }
    } else if (gesture && mode === BoardCanvasMode.Resizing && gesture.initialBounds && gesture.corner !== null) {
      gesture.resize = resizeBounds(gesture.initialBounds, gesture.corner, point);
      publishPreview(gesture);
    } else if (gesture && (mode === BoardCanvasMode.Pressing || mode === BoardCanvasMode.SelectionNet)) {
      if (Math.abs(point.x - gesture.origin.x) + Math.abs(point.y - gesture.origin.y) > 5) {
        setCanvasState({ mode: BoardCanvasMode.SelectionNet, origin: gesture.origin, current: point });
        const snapshot = runtime.board.getSnapshot();
        runtime.updatePresence({ selection: pickLayersInBox(snapshot.layerIds, snapshot.layers, gesture.origin, point) }, false);
      }
    } else if (gesture && mode === BoardCanvasMode.Pencil && runtime.board.canEdit) {
      const last = gesture.draft.at(-1);
      if (!last || last[0] !== point.x || last[1] !== point.y) {
        if (gesture.draft.length < 50_000) gesture.draft.push([point.x, point.y, sample.pressure || 0.5]);
      }
    } else if (gesture && mode === BoardCanvasMode.Eraser && runtime.board.canEdit) {
      for (const [id, layer] of runtime.board.getSnapshot().layers) {
        if (gesture.erase.has(id)) continue;
        const hit = layer.type === LayerType.Path
          ? doesPointIntersectPath(point, layer)
          : isPointNearBoundingBox(point, layer);
        if (hit) gesture.erase.add(id);
      }
      publishPreview(gesture);
    }
    const broadcast = performance.now() - lastPresence.current >= 50;
    if (broadcast) lastPresence.current = performance.now();
    runtime.updatePresence({ cursor: point,
      ...(mode === BoardCanvasMode.Pencil && gesture ? { pencilDraft: gesture.draft.slice(-5000) } : {}),
      ...(mode === BoardCanvasMode.Translating && gesture ? { drag: { ids: gesture.ids, delta: gesture.delta } } : {}),
    }, broadcast);
  };
  const processMoveRef = useRef(processMove);
  processMoveRef.current = processMove;

  const cancel = useCallback(() => {
    if (frame.current !== null) cancelAnimationFrame(frame.current);
    frame.current = null;
    latest.current = null;
    const pointerId = active.current?.pointerId;
    active.current = null;
    if (pointerId !== undefined && svgRef.current?.hasPointerCapture(pointerId)) svgRef.current.releasePointerCapture(pointerId);
    setPreview(emptyPreview());
    runtime.updatePresence({ pencilDraft: null, eraserDraft: null, drag: null });
    setCanvasState({ mode: BoardCanvasMode.None });
  }, [runtime, setCanvasState, svgRef]);

  const begin = (event: PointerEvent, ids: string[], mode: BoardCanvasMode, bounds: XYWH | null = null, corner: side | null = null) => {
    if (event.button !== 0 && event.button !== 1) return;
    const svg = svgRef.current;
    if (!svg) return;
    // Capturing a click on SVG retargets its later dblclick away from text content.
    // A translating gesture captures only after movement crosses the drag threshold.
    if (mode !== BoardCanvasMode.Translating) svg.setPointerCapture(event.pointerId);
    const point = toPoint(event);
    active.current = { pointerId: event.pointerId, origin: point, ids, delta: { x: 0, y: 0 },
      draft: [[point.x, point.y, event.pressure || 0.5]], erase: new Set(), initialBounds: bounds,
      resize: null, corner, screen: { x: event.clientX, y: event.clientY } };
    if (mode === BoardCanvasMode.Panning) {
      setCanvasState({ mode, origin: point, current: point, screenX: event.clientX, screenY: event.clientY,
        previousState: state.current });
    } else if (mode === BoardCanvasMode.Translating) setCanvasState({ mode, current: point });
    else if (mode === BoardCanvasMode.Resizing && bounds && corner !== null) setCanvasState({ mode, initial: bounds, corner });
    else if (mode === BoardCanvasMode.Pressing) setCanvasState({ mode, origin: point });
    if (mode === BoardCanvasMode.Pencil) runtime.updatePresence({ pencilDraft: active.current.draft,
      penColor: color, penSize });
    event.preventDefault();
  };

  const onPointerDown = (event: PointerEvent<SVGSVGElement>) => {
    if (active.current) return;
    if (event.button === 1) { begin(event, [], BoardCanvasMode.Panning); return; }
    if (event.button !== 0) return;
    const mode = state.current.mode;
    if (mode === BoardCanvasMode.Inserting || mode === BoardCanvasMode.Pencil || mode === BoardCanvasMode.Eraser) {
      if (runtime.board.canEdit) begin(event, [], mode);
      return;
    }
    const selection = runtime.getSelf().presence.selection;
    const layers = runtime.board.getSnapshot().layers;
    const selected = selection.map((id) => layers.get(id)).filter((layer) => layer !== undefined);
    const bounds = getBounds(selected);
    if (runtime.board.canEdit && bounds && isInsideBounds(toPoint(event), bounds)) {
      begin(event, [...selection], BoardCanvasMode.Translating, bounds);
    } else {
      runtime.updatePresence({ selection: [] });
      begin(event, [], BoardCanvasMode.Pressing);
    }
  };

  const onLayerPointerDown = useEvent((event: PointerEvent, id: string) => {
    if (event.button === 1 || state.current.mode === BoardCanvasMode.Inserting ||
      state.current.mode === BoardCanvasMode.Pencil || state.current.mode === BoardCanvasMode.Eraser) return;
    if (event.button !== 0) return;
    event.stopPropagation();
    let selection = runtime.getSelf().presence.selection;
    if (!selection.includes(id)) selection = event.shiftKey ? [...selection, id] : [id];
    runtime.updatePresence({ selection });
    if (runtime.board.canEdit) begin(event, [...selection], BoardCanvasMode.Translating);
  });

  const onResizeHandlePointerDown = useEvent((corner: side, initial: XYWH, event: PointerEvent) => {
    if (runtime.board.canEdit) begin(event, [...runtime.getSelf().presence.selection], BoardCanvasMode.Resizing, initial, corner);
  });

  const onPointerMove = (event: PointerEvent<SVGSVGElement>) => {
    const gesture = active.current;
    const svg = svgRef.current;
    if (gesture && svg && state.current.mode === BoardCanvasMode.Translating && !svg.hasPointerCapture(event.pointerId)) {
      const point = toPoint(event);
      if (Math.hypot(point.x - gesture.origin.x, point.y - gesture.origin.y) * cameraRef.current!.scale >= 3) {
        svg.setPointerCapture(event.pointerId);
      }
    }
    latest.current = { clientX: event.clientX, clientY: event.clientY, pressure: event.pressure, buttons: event.buttons };
    if (frame.current !== null) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = null;
      const sample = latest.current;
      if (sample) processMoveRef.current(sample);
    });
  };

  const onPointerUp = (event: PointerEvent<SVGSVGElement>) => {
    const gesture = active.current;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    if (frame.current !== null) cancelAnimationFrame(frame.current);
    frame.current = null;
    processMoveRef.current(event);
    const current = state.current;
    try {
      if (runtime.board.canEdit) {
        if (current.mode === BoardCanvasMode.Translating) runtime.board.translate(gesture.ids, gesture.delta);
        else if (current.mode === BoardCanvasMode.Resizing && gesture.resize) runtime.board.update(gesture.ids, { ...gesture.resize });
        else if (current.mode === BoardCanvasMode.Eraser) runtime.board.remove([...gesture.erase]);
        else if (current.mode === BoardCanvasMode.Pencil && gesture.draft.length > 1) {
          runtime.board.insert([makePathLayer(gesture.draft, color, penSize)]);
        } else if (current.mode === BoardCanvasMode.Inserting && current.layerType !== LayerType.Image && current.layerType !== LayerType.LinkPreview) {
          runtime.updatePresence({ selection: runtime.board.insert([createLayer(current.layerType, toPoint(event), color)]) });
        }
      }
    } catch (error) { toast.error(error instanceof Error ? error.message : "Не удалось изменить доску"); }
    const next: BoardCanvasState = current.mode === BoardCanvasMode.Pencil || current.mode === BoardCanvasMode.Eraser
      ? { mode: current.mode } : current.mode === BoardCanvasMode.Panning && current.previousState
        ? current.previousState : { mode: BoardCanvasMode.None };
    cancel();
    setCanvasState(next);
  };

  useEffect(() => {
    const releaseOutside = (event: globalThis.PointerEvent) => {
      if (active.current && event.target instanceof Node && !svgRef.current?.contains(event.target)) cancel();
    };
    window.addEventListener("blur", cancel);
    window.addEventListener("pointerup", releaseOutside);
    window.addEventListener("pointercancel", cancel);
    return () => {
      window.removeEventListener("blur", cancel);
      window.removeEventListener("pointerup", releaseOutside);
      window.removeEventListener("pointercancel", cancel);
    };
  }, [cancel, svgRef]);
  useEffect(() => () => { if (frame.current !== null) cancelAnimationFrame(frame.current); }, []);

  return { canvasState, setCanvasState, preview, cancel, onPointerDown, onLayerPointerDown,
    onResizeHandlePointerDown, onPointerMove, onPointerUp, onPointerCancel: cancel,
    onLostPointerCapture: () => { if (active.current) cancel(); },
    onPointerLeave: () => {
      const gesture = active.current;
      if (gesture && !svgRef.current?.hasPointerCapture(gesture.pointerId)) cancel();
      if (!active.current) runtime.updatePresence({ cursor: null });
    } };
}
