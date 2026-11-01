"use client";

import { type CSSProperties, useEffect, useMemo, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { useBoardHistory, useBoardRuntime, useBoardSnapshot, useConnectionState, useLayer, useOthers, usePencilDraft, useSelection } from "@/lib/collaboration/react";
import { getBounds, intersectsViewport } from "@/lib/board/geometry";
import { connectionIdToColor, rgbToCss } from "@/lib/utils";
import { BoardCanvasMode, Color, LayerType } from "@/types/board-canvas";
import { useCanvasCamera } from "../_hooks/use-canvas-camera";
import { useCanvasClipboard } from "../_hooks/use-canvas-clipboard";
import { useCanvasGestures } from "../_hooks/use-canvas-gestures";
import { usePenPreferences } from "../_hooks/use-pen-preferences";
import { useCanvasFollow } from "../_hooks/use-canvas-follow";
import { useCanvasLaser } from "../_hooks/use-canvas-laser";
import { BoardInfo } from "./info";
import { BoardParticipants } from "./participants";
import { BoardToolbar } from "./toolbar";
import { CursorsPresence } from "./cursors-presence";
import { GridBackground } from "./grid-background";
import { CanvasLayers } from "./canvas-layers";
import { Path } from "./path";
import { SelectionBox } from "./selection-box";
import { SelectionTools } from "./selection-tools";
import { TextSelectionTools } from "./text-selection-tools";
import { SessionTimer } from "./session-timer";
import { ZoomControls } from "./zoom-controls";
import { CanvasLoading } from "./canvas-loading";
import { SaveStatus } from "./save-status";
import { BoardTextProvider } from "@/components/board-text/provider";
import { Line } from "./line";
import { LaserPresence } from "./laser-presence";
import { GraphEditorProvider, useGraphEditor } from "@/components/board-graph/provider";

export { createLayer } from "@/lib/board/model";

const GraphEditor = dynamic(() => import("@/components/board-graph/editor").then((module) => module.GraphEditor), { ssr: false });

export function BoardCanvas({ boardId }: { boardId: string }) {
  return <BoardTextProvider><GraphEditorProvider><BoardCanvasContent boardId={boardId} /></GraphEditorProvider></BoardTextProvider>;
}

function BoardCanvasContent({ boardId }: { boardId: string }) {
  const runtime = useBoardRuntime();
  const graphEditor = useGraphEditor();
  const snapshot = useBoardSnapshot();
  const connection = useConnectionState();
  const selection = useSelection();
  const others = useOthers();
  const selectedLayer = useLayer(selection.length === 1 ? selection[0] : "");
  const pencilDraft = usePencilDraft();
  const history = useBoardHistory();
  const svgRef = useRef<SVGSVGElement | null>(null);
  const [lastUsedColor, setLastUsedColor] = useState<Color>({ r: 0, g: 0, b: 0 });
  const pen = usePenPreferences(runtime.session.user.id);
  const [viewport, setViewport] = useState({ width: 1920, height: 1080 });
  const stopFollowingRef = useRef<() => void>(() => undefined);
  const { camera, cameraRef, updateCamera, animateCameraTo, applyRemoteCamera, fitToScreen } = useCanvasCamera(svgRef,
    () => stopFollowingRef.current());
  const follow = useCanvasFollow({ camera, viewport, applyRemoteCamera });
  stopFollowingRef.current = follow.stopFollowing;
  const gestures = useCanvasGestures({ svgRef, cameraRef, updateCamera,
    color: lastUsedColor, penColor: pen.color, penSize: pen.size });
  const { insertImage } = useCanvasClipboard({ color: lastUsedColor, cancel: gestures.cancel, setCanvasState: gestures.setCanvasState });
  const { canvasState, preview } = gestures;
  const laserMode = canvasState.mode === BoardCanvasMode.Laser;
  const laser = useCanvasLaser({ active: laserMode, svgRef, cameraRef });
  const canEdit = runtime.board.canEdit && connection.synced && !connection.error;
  const previousGraphIds = useRef(new Set(snapshot.layerIds));
  const visibleBounds = useMemo(() => ({ x: -camera.x / camera.scale, y: -camera.y / camera.scale,
    width: viewport.width / camera.scale, height: viewport.height / camera.scale }), [camera, viewport]);

  useEffect(() => {
    if (!graphEditor.editingId || !canEdit) return;
    const layer = runtime.board.getLayer(graphEditor.editingId);
    if (layer?.type !== LayerType.Graph) return;
    // Opening the editor keeps the entire plot beside/above its panel.
    const mobile = viewport.width < 640;
    const area = { left: 76, top: mobile ? 120 : 86,
      right: mobile ? viewport.width - 16 : viewport.width - 376,
      bottom: mobile ? viewport.height * 0.55 - 80 : viewport.height - 64 };
    const current = cameraRef.current;
    if (layer.x * current.scale + current.x >= area.left &&
      layer.y * current.scale + current.y >= area.top &&
      (layer.x + layer.width) * current.scale + current.x <= area.right &&
      (layer.y + layer.height) * current.scale + current.y <= area.bottom) return;
    const scale = Math.max(0.1, Math.min(current.scale,
      Math.max(80, area.right - area.left) / Math.max(1, layer.width),
      Math.max(80, area.bottom - area.top) / Math.max(1, layer.height)));
    animateCameraTo({ scale, x: (area.left + area.right) / 2 - (layer.x + layer.width / 2) * scale,
      y: (area.top + area.bottom) / 2 - (layer.y + layer.height / 2) * scale });
  }, [graphEditor.editingId, canEdit, viewport.width, viewport.height, cameraRef, animateCameraTo, runtime]);

  useEffect(() => {
    const selectedId = selection.length === 1 ? selection[0] : null;
    if (graphEditor.editingId && (!canEdit || selectedId !== graphEditor.editingId || selectedLayer?.type !== LayerType.Graph ||
      [BoardCanvasMode.Inserting, BoardCanvasMode.Pencil, BoardCanvasMode.Eraser, BoardCanvasMode.Laser].includes(canvasState.mode))) {
      graphEditor.close();
    } else if (canEdit && selectedId && selectedLayer?.type === LayerType.Graph && !previousGraphIds.current.has(selectedId)) {
      graphEditor.open(selectedId);
    }
    previousGraphIds.current = new Set(snapshot.layerIds);
  }, [canEdit, selection, selectedLayer, snapshot.layerIds, canvasState.mode, graphEditor]);

  useEffect(() => {
    if (!graphEditor.editingId) return;
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (event.target instanceof Element && event.target.closest('[role="dialog"]')) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (graphEditor.navigationId) graphEditor.setNavigation(null);
      else graphEditor.close();
    };
    window.addEventListener("keydown", escape, true);
    return () => window.removeEventListener("keydown", escape, true);
  }, [graphEditor]);

  useEffect(() => {
    const resize = () => setViewport({ width: svgRef.current?.clientWidth ?? window.innerWidth,
      height: svgRef.current?.clientHeight ?? window.innerHeight });
    resize();
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, []);

  const selectedSet = useMemo(() => new Set(selection), [selection]);
  const visibleIds = useMemo(() => snapshot.layerIds.filter((id) => {
    const layer = snapshot.layers.get(id);
    return layer && (selectedSet.has(id) || intersectsViewport(layer, camera, viewport));
  }), [snapshot, selectedSet, camera, viewport]);
  const selectionColors = useMemo(() => {
    const colors: Record<string, string> = {};
    for (const other of others) {
      for (const id of other.presence.selection) colors[id] = connectionIdToColor(other.connectionId);
    }
    return colors;
  }, [others]);
  const remoteTransforms = useMemo(() => {
    const transforms = new Map<string, { x: number; y: number }>();
    for (const other of others) {
      if (!other.presence.drag) continue;
      for (const id of other.presence.drag.ids) transforms.set(id, other.presence.drag.delta);
    }
    return transforms;
  }, [others]);
  const movingIds = useMemo(() => new Set(preview.ids), [preview.ids]);
  // A fully moving rendered set shares one native SVG transform.
  const sharedTranslation = canvasState.mode === BoardCanvasMode.Translating && preview.ids.length > 0 &&
    !preview.resize && preview.erased.size === 0 && visibleIds.every((id) => movingIds.has(id));
  const cameraStyle: CSSProperties & Record<"--rimo-preview-x" | "--rimo-preview-y", string> = {
    transform: `translate(${camera.x}px, ${camera.y}px) scale(${camera.scale})`, transformOrigin: "0 0",
    "--rimo-preview-x": `${sharedTranslation ? 0 : preview.delta.x}px`,
    "--rimo-preview-y": `${sharedTranslation ? 0 : preview.delta.y}px`,
  };
  const selectionBounds = useMemo(() => {
    if (preview.line && preview.ids.length) return preview.line;
    if (preview.resize) return preview.resize;
    if (!preview.ids.length) return null;
    const bounds = getBounds(preview.ids.map((id) => snapshot.layers.get(id)).filter((layer) => layer !== undefined));
    return bounds ? { ...bounds, x: bounds.x + preview.delta.x, y: bounds.y + preview.delta.y } : null;
  }, [preview, snapshot]);

  return <main className="h-full w-full relative bg-neutral touch-none" data-board-id={boardId}>
    <BoardInfo boardId={boardId} />
    <div className="absolute top-16 right-2 flex flex-row-reverse items-center gap-2 sm:top-2">
      <BoardParticipants followingId={follow.followingId} onFollow={(id) => {
        gestures.cancel(); laser.clear(); follow.toggleFollow(id);
      }} /><SessionTimer />
    </div>
    {connection.synced && !connection.error && <BoardToolbar readOnly={!canEdit}
      canvasState={canvasState} setCanvasState={gestures.setCanvasState}
      undo={history.undo} redo={history.redo} canUndo={history.canUndo} canRedo={history.canRedo}
      selectedPenColor={pen.color} onPenColorChange={pen.setColor}
      selectedPenSize={pen.size} onImageUpload={insertImage} onPenSizeChange={(size) => {
        pen.setSize(size); gestures.setCanvasState({ mode: BoardCanvasMode.Pencil });
      }} camera={camera} animateCameraTo={animateCameraTo} />}
    {canEdit && !laserMode && preview.ids.length === 0 && !preview.line && (selectedLayer?.type === LayerType.Text || selectedLayer?.type === LayerType.Sticker
      ? <TextSelectionTools camera={camera} setLastUsedColor={setLastUsedColor} />
      : <SelectionTools camera={camera} setLastUsedColor={setLastUsedColor} />)}
    {graphEditor.editingId && <GraphEditor />}
    <svg ref={svgRef} className="h-[100vh] w-[100vw]" aria-label="Холст доски"
      onPointerDownCapture={(event) => {
        if (event.target instanceof Element && event.target.closest('[data-graph-interaction="true"]')) return;
        laser.onPointerDown(event);
        gestures.onPointerDownCapture(event);
      }}
      onPointerMove={(event) => { gestures.onPointerMove(event); laser.onPointerMove(event); }}
      onPointerLeave={(event) => { gestures.onPointerLeave(event); laser.onPointerLeave(event); }}
      onPointerDown={gestures.onPointerDown}
      onPointerUp={(event) => { gestures.onPointerUp(event); laser.onPointerUp(event); }}
      onPointerCancel={(event) => { gestures.onPointerCancel(event); laser.onPointerCancel(event); }}
      onLostPointerCapture={(event) => {
        gestures.onLostPointerCapture(event);
        if (!svgRef.current?.hasPointerCapture(event.pointerId)) laser.onPointerCancel(event);
      }}
      style={{ cursor: laserMode ? "crosshair" : canvasState.mode === BoardCanvasMode.Pencil ? 'url("/cursors/pencil.svg") 2 14, auto'
        : canvasState.mode === BoardCanvasMode.Eraser ? 'url("/cursors/eraser.svg") 4 4, auto'
          : canvasState.mode === BoardCanvasMode.Inserting ? "crosshair"
            : canvasState.mode === BoardCanvasMode.Panning ? "grabbing" : "default" }}>
      <GridBackground camera={camera} />
      <g data-board-layers="true" style={cameraStyle}>
        <g data-preview-group="true" data-shared-preview={sharedTranslation ? "true" : undefined}
          transform={`translate(${sharedTranslation ? preview.delta.x : 0} ${sharedTranslation ? preview.delta.y : 0})`}>
          <CanvasLayers snapshot={snapshot} visibleIds={visibleIds} movingIds={movingIds} previewIds={preview.ids}
            erased={preview.erased.size ? preview.erased : null} resize={preview.resize} sharedTranslation={sharedTranslation}
            viewport={visibleBounds} linePreview={preview.ids.length ? preview.line : null}
            lineDelta={preview.ids.some((id) => snapshot.layers.get(id)?.type === LayerType.Line) ? preview.delta : undefined}
            remoteTransforms={remoteTransforms} selectionColors={selectionColors} onLayerPointerDown={gestures.onLayerPointerDown} />
        </g>
        {preview.line && !preview.ids.length && <Line id="line-draft" layer={preview.line} viewport={visibleBounds} />}
        {!laserMode && <SelectionBox onResizeHandlePointerDown={gestures.onResizeHandlePointerDown} boundsOverride={selectionBounds}
          showLineHandles={![BoardCanvasMode.Inserting, BoardCanvasMode.Pencil, BoardCanvasMode.Eraser, BoardCanvasMode.Laser].includes(canvasState.mode)}
          onLineEndpointPointerDown={gestures.onLineEndpointPointerDown} lineOverride={preview.ids.length ? preview.line : null} scale={camera.scale} />}
        {canvasState.mode === BoardCanvasMode.SelectionNet && canvasState.current && <rect
          className="fill-blue-500/5 stroke-blue-500 stroke-1"
          x={Math.min(canvasState.origin.x, canvasState.current.x)} y={Math.min(canvasState.origin.y, canvasState.current.y)}
          width={Math.abs(canvasState.origin.x - canvasState.current.x)} height={Math.abs(canvasState.origin.y - canvasState.current.y)} />}
        <CursorsPresence />
        <LaserPresence scale={camera.scale} />
        {pencilDraft && pencilDraft.length > 0 && <Path points={pencilDraft} x={0} y={0}
          fill={rgbToCss(gestures.pencilStyle.color)} size={gestures.pencilStyle.size} />}
      </g>
    </svg>
    <ZoomControls scale={camera.scale} onFitToScreen={fitToScreen} />
    {laserMode && <div role="status" className="pointer-events-none absolute bottom-14 left-1/2 max-w-[calc(100%-2rem)] -translate-x-1/2 rounded-lg bg-white/95 px-3 py-2 text-center text-xs text-neutral-600 shadow-sm">
      Удерживайте нажатие, чтобы показать указку
    </div>}
    <SaveStatus />
    {!connection.synced && !connection.error && <div className="absolute inset-0 z-20"><CanvasLoading /></div>}
  </main>;
}
