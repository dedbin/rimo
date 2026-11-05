"use client";

import { PointerEvent, RefObject, useCallback, useEffect, useRef, useState } from "react";
import { useBoardRuntime } from "@/lib/collaboration/react";
import { useEvent } from "@/lib/collaboration/use-event";
import { getBounds, isInsideBounds } from "@/lib/board/geometry";
import { createLayer } from "@/lib/board/model";
import { createLine, distanceToLine, lineBounds, lineEndpoints, snapLineEnd } from "@/lib/board/line";
import type { LineLayer } from "@/types/board-canvas";
import { doesPointIntersectPath, isPointNearBoundingBox, makePathLayer, pickLayersInBox, pointerEventToCanvasPoint, resizeBounds } from "@/lib/utils";
import { BoardCanvasMode, BoardCanvasState, Camera, Color, LayerType, Point, side, XYWH } from "@/types/board-canvas";
import { toast } from "sonner";
import { useCanvasTouch } from "./use-canvas-touch";
import { resizeGraphBounds } from "@/lib/board/graph/resize";
import type { CanvasPointerSample } from "@/lib/board/pointer-sample";

type PointerSample = Pick<CanvasPointerSample, "clientX" | "clientY" | "pressure" | "buttons" | "shiftKey">;
interface ActiveGesture {
  pointerId: number;
  pointerType: string;
  initialState: BoardCanvasState;
  penColor: Color;
  penSize: number;
  origin: Point;
  ids: string[];
  delta: Point;
  draft: number[][];
  erase: Set<string>;
  initialBounds: XYWH | null;
  resize: XYWH | null;
  corner: side | null;
  screen: Point;
  line: LineLayer | null;
  initialLine: LineLayer | null;
}
export interface GesturePreview {
  ids: readonly string[];
  delta: Point;
  resize: XYWH | null;
  erased: ReadonlySet<string>;
  line: LineLayer | null;
}
const emptyPreview = (): GesturePreview => ({ ids: [], delta: { x: 0, y: 0 }, resize: null, erased: new Set(), line: null });

interface Options {
  svgRef: RefObject<SVGSVGElement | null>;
  cameraRef: RefObject<Camera>;
  updateCamera: (camera: Camera) => void;
  color: Color;
  penColor?: Color;
  penSize: number;
}

export function useCanvasGestures({ svgRef, cameraRef, updateCamera, color, penColor = color, penSize }: Options) {
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
    setPreview({ ids: gesture.ids, delta: { ...gesture.delta }, resize: gesture.resize, erased: new Set(gesture.erase), line: gesture.line });
  };

  const processMove = (sample: PointerSample) => {
    if (!svgRef.current) return;
    const point = toPoint(sample);
    const gesture = active.current;
    const mode = state.current.mode;
    if (mode === BoardCanvasMode.Laser) return;
    if (gesture && state.current.mode === BoardCanvasMode.Inserting && state.current.layerType === LayerType.Line) {
      const end = sample.shiftKey ? snapLineEnd(gesture.origin, point) : point;
      gesture.line = createLine(gesture.origin, end, color, state.current.lineKind, state.current.strokeStyle);
      publishPreview(gesture);
    } else if (gesture && state.current.mode === BoardCanvasMode.EditingLine && gesture.initialLine) {
      const [start, end] = lineEndpoints(gesture.initialLine);
      const editingStart = state.current.endpoint === "start";
      const fixed = editingStart ? end : start;
      const moving = sample.shiftKey ? snapLineEnd(fixed, point) : point;
      if (Math.hypot(moving.x - fixed.x, moving.y - fixed.y) >= 0.001) {
        gesture.line = { ...gesture.initialLine, ...lineBounds(editingStart ? moving : start, editingStart ? end : moving) };
        publishPreview(gesture);
      }
    } else if (gesture && mode === BoardCanvasMode.Panning) {
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
      const graph = gesture.ids.length === 1 && runtime.board.getLayer(gesture.ids[0])?.type === LayerType.Graph;
      gesture.resize = graph ? resizeGraphBounds(gesture.initialBounds, gesture.corner, point)
        : resizeBounds(gesture.initialBounds, gesture.corner, point);
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
        const hit = layer.type === LayerType.Line ? distanceToLine(point, layer) <= 12 / cameraRef.current!.scale + layer.strokeWidth / 2
          : layer.type === LayerType.Path
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
  const captureTranslation = useCallback((sample: PointerSample & { pointerId: number }) => {
    const gesture = active.current;
    const svg = svgRef.current;
    if (!gesture || !svg || !(sample.buttons & 1) || state.current.mode !== BoardCanvasMode.Translating ||
      svg.hasPointerCapture(gesture.pointerId)) return;
    if (Math.hypot(sample.clientX - gesture.screen.x, sample.clientY - gesture.screen.y) >= 3) svg.setPointerCapture(gesture.pointerId);
  }, [svgRef]);
  const refreshPointer = useEvent((sample: CanvasPointerSample) => {
    const gesture = active.current;
    if (gesture && (gesture.pointerId !== sample.pointerId || gesture.pointerType !== sample.pointerType)) return;
    captureTranslation(sample);
    if (frame.current !== null) cancelAnimationFrame(frame.current);
    frame.current = null;
    latest.current = sample;
    processMoveRef.current(sample);
  });

  const clearGesture = useCallback((releaseCapture = true) => {
    if (frame.current !== null) cancelAnimationFrame(frame.current);
    frame.current = null;
    latest.current = null;
    const pointerId = active.current?.pointerId;
    active.current = null;
    if (releaseCapture && pointerId !== undefined && svgRef.current?.hasPointerCapture(pointerId)) svgRef.current.releasePointerCapture(pointerId);
    setPreview(emptyPreview());
    runtime.updatePresence({ pencilDraft: null, eraserDraft: null, drag: null });
  }, [runtime, svgRef]);
  const touch = useCanvasTouch({ svgRef, cameraRef, updateCamera, onNavigate: () => {
    const initial = active.current?.initialState ?? state.current;
    clearGesture(false);
    setCanvasState(initial.mode === BoardCanvasMode.Pencil || initial.mode === BoardCanvasMode.Eraser || initial.mode === BoardCanvasMode.Laser ||
      initial.mode === BoardCanvasMode.Inserting ? initial : { mode: BoardCanvasMode.None });
  } });
  const canAutoPan = useEvent((sample: CanvasPointerSample): boolean => {
    if (state.current.mode === BoardCanvasMode.Panning || touch.blocks(sample)) return false;
    const gesture = active.current;
    if (!gesture) return true;
    if (gesture.pointerId !== sample.pointerId || gesture.pointerType !== sample.pointerType) return false;
    const dx = sample.clientX - gesture.screen.x;
    const dy = sample.clientY - gesture.screen.y;
    if (state.current.mode === BoardCanvasMode.Pressing) return (Math.abs(dx) + Math.abs(dy)) / cameraRef.current!.scale > 5;
    if (state.current.mode === BoardCanvasMode.Translating) return Math.hypot(dx, dy) >= 3 || !!svgRef.current?.hasPointerCapture(gesture.pointerId);
    return true;
  });
  const cancel = useEvent(() => {
    if (active.current?.pointerType === "pen") touch.finish(active.current);
    clearGesture();
    touch.cancelNavigation();
    setCanvasState({ mode: BoardCanvasMode.None });
  });

  useEffect(() => {
    let writable = runtime.board.canEdit;
    return runtime.subscribeState(() => {
      const next = runtime.board.canEdit;
      const lost = writable && !next;
      writable = next;
      if (lost) cancel();
    });
  }, [runtime, cancel]);

  const begin = (event: PointerEvent, ids: string[], mode: BoardCanvasMode, bounds: XYWH | null = null, corner: side | null = null) => {
    if (active.current || touch.blocks(event) || (event.button !== 0 && event.button !== 1)) return false;
    const svg = svgRef.current;
    if (!svg) return false;
    if (mode === BoardCanvasMode.Panning) updateCamera({ ...cameraRef.current! });
    // Capturing a click on SVG retargets its later dblclick away from text content.
    // A translating gesture captures only after movement crosses the drag threshold.
    if (mode !== BoardCanvasMode.Translating) svg.setPointerCapture(event.pointerId);
    const point = toPoint(event);
    active.current = { pointerId: event.pointerId, pointerType: event.pointerType || "mouse", initialState: state.current,
      penColor: { ...penColor }, penSize, origin: point, ids, delta: { x: 0, y: 0 },
      draft: [[point.x, point.y, event.pressure || 0.5]], erase: new Set(), initialBounds: bounds,
      resize: null, corner, screen: { x: event.clientX, y: event.clientY }, line: null, initialLine: null };
    if (mode === BoardCanvasMode.Panning) {
      setCanvasState({ mode, origin: point, current: point, screenX: event.clientX, screenY: event.clientY,
        previousState: state.current });
    } else if (mode === BoardCanvasMode.Translating) setCanvasState({ mode, current: point });
    else if (mode === BoardCanvasMode.Resizing && bounds && corner !== null) setCanvasState({ mode, initial: bounds, corner });
    else if (mode === BoardCanvasMode.Pressing) setCanvasState({ mode, origin: point });
    if (mode === BoardCanvasMode.Pencil) runtime.updatePresence({ pencilDraft: active.current.draft,
      penColor: active.current.penColor, penSize: active.current.penSize });
    event.preventDefault();
    return true;
  };

  const onPointerDown = (event: PointerEvent<SVGSVGElement>) => {
    if (active.current || touch.blocks(event)) return;
    if (event.button === 1) { begin(event, [], BoardCanvasMode.Panning); return; }
    if (event.button !== 0) return;
    const mode = state.current.mode;
    if (mode === BoardCanvasMode.Laser) return;
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
    if (active.current || touch.blocks(event)) return;
    if (event.button === 1 || state.current.mode === BoardCanvasMode.Inserting ||
      state.current.mode === BoardCanvasMode.Pencil || state.current.mode === BoardCanvasMode.Eraser ||
      state.current.mode === BoardCanvasMode.Laser) return;
    if (event.button !== 0) return;
    event.stopPropagation();
    let selection = runtime.getSelf().presence.selection;
    if (!selection.includes(id)) selection = event.shiftKey ? [...selection, id] : [id];
    runtime.updatePresence({ selection });
    if (runtime.board.canEdit) begin(event, [...selection], BoardCanvasMode.Translating);
  });

  const onResizeHandlePointerDown = useEvent((corner: side, initial: XYWH, event: PointerEvent) => {
    if (state.current.mode === BoardCanvasMode.Laser) return;
    if (runtime.board.canEdit) begin(event, [...runtime.getSelf().presence.selection], BoardCanvasMode.Resizing, initial, corner);
  });

  const onLineEndpointPointerDown = useEvent((id: string, endpoint: "start" | "end", event: PointerEvent) => {
    if (state.current.mode === BoardCanvasMode.Inserting || state.current.mode === BoardCanvasMode.Pencil ||
      state.current.mode === BoardCanvasMode.Eraser || state.current.mode === BoardCanvasMode.Laser) return;
    const layer = runtime.board.getLayer(id);
    if (!runtime.board.canEdit || layer?.type !== LayerType.Line || event.button !== 0) return;
    if (!begin(event, [id], BoardCanvasMode.EditingLine) || !active.current) return;
    active.current.initialLine = layer;
    active.current.line = layer;
    setCanvasState({ mode: BoardCanvasMode.EditingLine, id, endpoint });
    publishPreview(active.current);
  });

  const onPointerMove = (event: PointerEvent<SVGSVGElement>) => {
    if (touch.onPointerMove(event)) return;
    const gesture = active.current;
    if (gesture && gesture.pointerId !== event.pointerId) return;
    captureTranslation(event);
    latest.current = { clientX: event.clientX, clientY: event.clientY, pressure: event.pressure, buttons: event.buttons, shiftKey: event.shiftKey };
    if (frame.current !== null) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = null;
      const sample = latest.current;
      if (sample) processMoveRef.current(sample);
    });
  };

  const onPointerUp = (event: PointerEvent<SVGSVGElement>) => {
    if (touch.finish(event)) return;
    const gesture = active.current;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    if (frame.current !== null) cancelAnimationFrame(frame.current);
    frame.current = null;
    processMoveRef.current(event);
    const current = state.current;
    try {
      if (runtime.board.canEdit) {
        if (current.mode === BoardCanvasMode.Translating) runtime.board.translate(gesture.ids, gesture.delta);
        else if (current.mode === BoardCanvasMode.EditingLine && gesture.line) {
          const { x, y, width, height, start, end } = gesture.line;
          runtime.board.update([current.id], { x, y, width, height, start, end });
        }
        else if (current.mode === BoardCanvasMode.Resizing && gesture.resize) {
          if (gesture.ids.length === 1 && runtime.board.getLayer(gesture.ids[0])?.type === LayerType.Graph) {
            runtime.board.resizeGraph(gesture.ids[0], gesture.resize);
          } else runtime.board.update(gesture.ids, { ...gesture.resize });
        }
        else if (current.mode === BoardCanvasMode.Eraser) runtime.board.remove([...gesture.erase]);
        else if (current.mode === BoardCanvasMode.Pencil && gesture.draft.length > 1) {
          runtime.board.insert([makePathLayer(gesture.draft, gesture.penColor, gesture.penSize)]);
        } else if (current.mode === BoardCanvasMode.Inserting && current.layerType === LayerType.Line) {
          if (gesture.line) {
            const [start, end] = lineEndpoints(gesture.line);
            if (Math.hypot(end.x - start.x, end.y - start.y) * cameraRef.current!.scale >= 3) {
              runtime.updatePresence({ selection: runtime.board.insert([gesture.line]) });
            }
          }
        } else if (current.mode === BoardCanvasMode.Inserting && current.layerType !== LayerType.Image && current.layerType !== LayerType.LinkPreview) {
          runtime.updatePresence({ selection: runtime.board.insert([createLayer(current.layerType, toPoint(event), color)]) });
        }
      }
    } catch (error) { toast.error(error instanceof Error ? error.message : "Не удалось изменить доску"); }
    const next: BoardCanvasState = current.mode === BoardCanvasMode.Inserting && current.layerType === LayerType.Line ? current
      : current.mode === BoardCanvasMode.Pencil || current.mode === BoardCanvasMode.Eraser
      ? { mode: current.mode } : current.mode === BoardCanvasMode.Panning && current.previousState
        ? current.previousState : { mode: BoardCanvasMode.None };
    cancel();
    setCanvasState(next);
  };

  const onPointerCancel = useEvent((event?: Pick<PointerEvent, "pointerId">) => {
    if (!event) { cancel(); return; }
    const consumed = touch.finish(event);
    if (consumed) touch.cancelNavigation();
    if (active.current?.pointerId === event.pointerId) cancel();
  });

  useEffect(() => {
    const releaseOutside = (event: globalThis.PointerEvent) => {
      if (!(event.target instanceof Node) || svgRef.current?.contains(event.target)) return;
      touch.finish(event);
      if (active.current?.pointerId === event.pointerId) cancel();
    };
    const blur = () => { cancel(); touch.reset(); };
    window.addEventListener("blur", blur);
    window.addEventListener("pointerup", releaseOutside);
    window.addEventListener("pointercancel", onPointerCancel);
    return () => {
      window.removeEventListener("blur", blur);
      window.removeEventListener("pointerup", releaseOutside);
      window.removeEventListener("pointercancel", onPointerCancel);
    };
  }, [cancel, onPointerCancel, svgRef, touch]);
  useEffect(() => () => {
    if (frame.current !== null) cancelAnimationFrame(frame.current);
    touch.reset();
  }, [touch]);

  return { canvasState, setCanvasState, preview, cancel, refreshPointer, canAutoPan, onPointerDown, onLayerPointerDown,
    onPointerDownCapture: (event: PointerEvent<SVGSVGElement>) => touch.onPointerDownCapture(event, active.current?.pointerType),
    pencilStyle: { color: active.current?.penColor ?? penColor, size: active.current?.penSize ?? penSize },
    onResizeHandlePointerDown, onLineEndpointPointerDown, onPointerMove, onPointerUp, onPointerCancel,
    onLostPointerCapture: (event?: PointerEvent<SVGSVGElement>) => {
      // A touch target's implicit capture may be transferred to our SVG. Its
      // bubbling lostcapture is expected while the SVG still owns the pointer.
      if (event && svgRef.current?.hasPointerCapture(event.pointerId)) return;
      if (active.current && (!event || active.current.pointerId === event.pointerId)) cancel();
      else if (event && touch.owns(event.pointerId)) touch.cancelNavigation();
    },
    onPointerLeave: (event?: Pick<PointerEvent, "pointerId">) => {
      const gesture = active.current;
      if (event && gesture && gesture.pointerId !== event.pointerId) return;
      if (gesture && !svgRef.current?.hasPointerCapture(gesture.pointerId)) cancel();
      if (!active.current) runtime.updatePresence({ cursor: null });
    } };
}
