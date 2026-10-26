"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useBoardHistory, useBoardRuntime, useBoardSnapshot, useConnectionState, useLayer, useOthers, usePencilDraft, useSelection } from "@/lib/collaboration/react";
import { getBounds, intersectsViewport } from "@/lib/board/geometry";
import { connectionIdToColor, rgbToCss } from "@/lib/utils";
import { BoardCanvasMode, Color, LayerType } from "@/types/board-canvas";
import { useCanvasCamera } from "../_hooks/use-canvas-camera";
import { useCanvasClipboard } from "../_hooks/use-canvas-clipboard";
import { useCanvasGestures } from "../_hooks/use-canvas-gestures";
import { BoardInfo } from "./info";
import { BoardParticipants } from "./participants";
import { BoardToolbar } from "./toolbar";
import { CursorsPresence } from "./cursors-presence";
import { GridBackground } from "./grid-background";
import { LayerPreview } from "./layer-preview";
import { Path } from "./path";
import { SelectionBox } from "./selection-box";
import { SelectionTools } from "./selection-tools";
import { TextSelectionTools } from "./text-selection-tools";
import { SessionTimer } from "./session-timer";
import { ZoomControls } from "./zoom-controls";
import { CanvasLoading } from "./canvas-loading";
import { SaveStatus } from "./save-status";

export { createLayer } from "@/lib/board/model";

export function BoardCanvas({ boardId }: { boardId: string }) {
  const runtime = useBoardRuntime();
  const snapshot = useBoardSnapshot();
  const connection = useConnectionState();
  const selection = useSelection();
  const others = useOthers();
  const selectedLayer = useLayer(selection.length === 1 ? selection[0] : "");
  const pencilDraft = usePencilDraft();
  const history = useBoardHistory();
  const svgRef = useRef<SVGSVGElement | null>(null);
  const [lastUsedColor, setLastUsedColor] = useState<Color>({ r: 0, g: 0, b: 0 });
  const [lastUsedSize, setLastUsedSize] = useState(16);
  const [viewport, setViewport] = useState({ width: 1920, height: 1080 });
  const { camera, cameraRef, updateCamera, animateCameraTo, fitToScreen } = useCanvasCamera(svgRef);
  const gestures = useCanvasGestures({ svgRef, cameraRef, updateCamera, color: lastUsedColor, penSize: lastUsedSize });
  const { insertImage } = useCanvasClipboard({ color: lastUsedColor, cancel: gestures.cancel, setCanvasState: gestures.setCanvasState });
  const { canvasState, preview } = gestures;
  const canEdit = runtime.board.canEdit && connection.synced && !connection.error;

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
  const movingLayers = useMemo(() => preview.ids.map((id) => {
    const stored = snapshot.layers.get(id);
    if (!stored) return null;
    return <LayerPreview key={id} id={id} onLayerPointerDown={gestures.onLayerPointerDown}
      selectionColor={selectionColors[id]} layerOverride={preview.resize ? { ...stored, ...preview.resize } : undefined} />;
  }), [preview.ids, preview.resize, snapshot, gestures.onLayerPointerDown, selectionColors]);
  const selectionBounds = useMemo(() => {
    if (preview.resize) return preview.resize;
    if (!preview.ids.length) return null;
    const bounds = getBounds(preview.ids.map((id) => snapshot.layers.get(id)).filter((layer) => layer !== undefined));
    return bounds ? { ...bounds, x: bounds.x + preview.delta.x, y: bounds.y + preview.delta.y } : null;
  }, [preview, snapshot]);

  return <main className="h-full w-full relative bg-neutral touch-none" data-board-id={boardId}>
    <BoardInfo boardId={boardId} />
    <div className="absolute top-2 right-2 flex flex-row-reverse items-center gap-2">
      <BoardParticipants /><SessionTimer />
    </div>
    {canEdit && <BoardToolbar canvasState={canvasState} setCanvasState={gestures.setCanvasState}
      undo={history.undo} redo={history.redo} canUndo={history.canUndo} canRedo={history.canRedo}
      selectedPenSize={lastUsedSize} onImageUpload={insertImage} onPenSizeChange={(size) => {
        setLastUsedSize(size); gestures.setCanvasState({ mode: BoardCanvasMode.Pencil });
      }} camera={camera} animateCameraTo={animateCameraTo} />}
    {canEdit && preview.ids.length === 0 && (selectedLayer?.type === LayerType.Text || selectedLayer?.type === LayerType.Sticker
      ? <TextSelectionTools camera={camera} setLastUsedColor={setLastUsedColor} />
      : <SelectionTools camera={camera} setLastUsedColor={setLastUsedColor} />)}
    <svg ref={svgRef} className="h-[100vh] w-[100vw]" aria-label="Холст доски"
      onPointerMove={gestures.onPointerMove} onPointerLeave={gestures.onPointerLeave}
      onPointerDown={gestures.onPointerDown} onPointerUp={gestures.onPointerUp}
      onPointerCancel={gestures.onPointerCancel} onLostPointerCapture={gestures.onLostPointerCapture}
      style={{ cursor: canvasState.mode === BoardCanvasMode.Pencil ? 'url("/cursors/pencil.svg") 2 14, auto'
        : canvasState.mode === BoardCanvasMode.Eraser ? 'url("/cursors/eraser.svg") 4 4, auto'
          : canvasState.mode === BoardCanvasMode.Inserting ? "crosshair"
            : canvasState.mode === BoardCanvasMode.Panning ? "grabbing" : "default" }}>
      <GridBackground camera={camera} />
      <g style={{ transform: `translate(${camera.x}px, ${camera.y}px) scale(${camera.scale})`, transformOrigin: "0 0" }}>
        {visibleIds.map((id) => {
          if (movingIds.has(id) || preview.erased.has(id)) return null;
          const remote = remoteTransforms.get(id);
          return <g key={id} transform={remote ? `translate(${remote.x} ${remote.y})` : undefined}>
            <LayerPreview id={id} onLayerPointerDown={gestures.onLayerPointerDown} selectionColor={selectionColors[id]} />
          </g>;
        })}
        <g transform={`translate(${preview.delta.x} ${preview.delta.y})`}>{movingLayers}</g>
        <SelectionBox onResizeHandlePointerDown={gestures.onResizeHandlePointerDown} boundsOverride={selectionBounds} />
        {canvasState.mode === BoardCanvasMode.SelectionNet && canvasState.current && <rect
          className="fill-blue-500/5 stroke-blue-500 stroke-1"
          x={Math.min(canvasState.origin.x, canvasState.current.x)} y={Math.min(canvasState.origin.y, canvasState.current.y)}
          width={Math.abs(canvasState.origin.x - canvasState.current.x)} height={Math.abs(canvasState.origin.y - canvasState.current.y)} />}
        <CursorsPresence />
        {pencilDraft && pencilDraft.length > 0 && <Path points={pencilDraft} x={0} y={0}
          fill={rgbToCss(lastUsedColor)} size={lastUsedSize} />}
      </g>
    </svg>
    <ZoomControls scale={camera.scale} onFitToScreen={fitToScreen} />
    <SaveStatus />
    {!connection.synced && !connection.error && <div className="absolute inset-0 z-20"><CanvasLoading /></div>}
  </main>;
}
