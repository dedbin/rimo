"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  BoardCanvasState,
  BoardCanvasMode,
  Camera,
  Color,
  LayerType,
  Point,
  side,
  XYWH,
} from "@/types/board-canvas";

import { BoardInfo } from "./info";
import { BoardParticipants } from "./participants";
import { BoardToolbar } from "./toolbar";
import {
  useHistory,
  useCanRedo,
  useCanUndo,
  useUpdateMyPresence,
  useMutation,
  useStorage
} from "@liveblocks/react/suspense";
import { CursorsPresence } from "./cursors-presence";
import { connectionIdToColor, pointerEventToCanvasPoint, resizeBounds } from "@/lib/utils";
import { nanoid } from "nanoid";
import { LiveObject } from "@liveblocks/client";
import { set } from "date-fns";
import { LayerPreview } from "./layer-preview";
import { useOthersMapped } from "@liveblocks/react";
import { SelectionBox } from "./selection-box";
import { SelectionTools } from "./selection-tools";

const MAX_LAYERS = 100;

interface BoardCanvasProps {
  boardId: string;
}

export const BoardCanvas = ({ boardId }: BoardCanvasProps) => {
  const layerIds = useStorage((root) => root.layerIds);

  if (!layerIds) {
    console.error("layerIds not found"); // todo: make pretty error screen
    return null;
  }
  
  const [canvasState, setCanvasState] = useState<BoardCanvasState>({
    mode: BoardCanvasMode.None,
  });

  const [camera, setCamera] = useState<Camera>({ x: 0, y: 0 });
  const [lastUsedColor, setLastUsedColor] = useState<Color>({r: 0, g: 0, b: 0,}); 

  const cameraRef = useRef<Camera>(camera);
  const rafRef = useRef<number | null>(null);

  const history = useHistory();
  const canUndo = useCanUndo();
  const canRedo = useCanRedo();

  const insertLayer = useMutation((
    { storage, setMyPresence },
    layerType: LayerType.Ellipse | LayerType.Rectangle | LayerType.Sticker | LayerType.Text,
    position: Point
  ) => {
    const liveLayers = storage.get("layers");

    if (liveLayers.size >= MAX_LAYERS) {
      console.warn("Max layers reached");
      return;
    }

    const liveLayerIds = storage.get("layerIds");
    const layerId = nanoid();
    const layer = new LiveObject({
      type: layerType,
      x: position.x,
      y: position.y,
      height: 100,
      width: 100, // TODO: maybe make this variable depending on layer type
      fill: lastUsedColor,
    });

    liveLayerIds.push(layerId);
    liveLayers.set(layerId, layer);

    setMyPresence({selection: [layerId],}, { addToHistory: true });
    setCanvasState({ mode: BoardCanvasMode.None });
  }, [lastUsedColor]
);

  const unselectLayer = useMutation(({ self, setMyPresence }) => {
    if (self.presence.selection.length > 0) {
      setMyPresence({ selection: [] }, { addToHistory: true });
    };
  }, [])

  const resizeLayer = useMutation(({ storage, self }, point: Point) => {
    if (canvasState.mode !== BoardCanvasMode.Resizing) return;

    const bounds = resizeBounds(canvasState.initial, canvasState.corner, point);

    const liveLayers = storage.get("layers");

    const layer = liveLayers.get(self.presence.selection[0]);

    if (layer) layer.update(bounds);
  }, [canvasState]);

  const translateLayer = useMutation(({ storage, self }, point: Point) => {
    if (canvasState.mode !== BoardCanvasMode.Translating) return;
    const offset = { x: point.x - canvasState.current.x, y: point.y - canvasState.current.y };

    const liveLayers = storage.get("layers");

    for (const id of self.presence.selection) {
      const layer = liveLayers.get(id);
      if (layer) layer.update({ x: layer.get('x') + offset.x, y: layer.get('y')+ offset.y });
    }

    setCanvasState({ mode: BoardCanvasMode.Translating, current: point });
  },[canvasState])

  const updateMyPresence = useUpdateMyPresence();

  useEffect(() => {
    cameraRef.current = camera;
  }, [camera]);

  const onResizeHandlePointerDown = useCallback(
    (corner: side, initialBounds: XYWH) => {
      // console.log("onResizeHandlePointerDown", { corner, initialBounds });
      history.pause();
      setCanvasState({ mode: BoardCanvasMode.Resizing, initial: initialBounds, corner });
    },
    [history]
  );

  const onWheel = useCallback((e: React.WheelEvent) => {
    setCamera((prev) => ({
      x: prev.x - e.deltaX,
      y: prev.y - e.deltaY,
    }));
  }, []);

  const onPointerMove = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault();

      if (rafRef.current) return;

      rafRef.current = requestAnimationFrame(() => {
        const point = pointerEventToCanvasPoint(e, cameraRef.current);

        if (canvasState.mode === BoardCanvasMode.Translating) {
          translateLayer(point)
        } else if (canvasState.mode === BoardCanvasMode.Resizing) {
        resizeLayer(point)
      }
        updateMyPresence(
          { cursor: point },
          { addToHistory: false }
        );

        rafRef.current = null;
      });
    },
    [updateMyPresence, canvasState.mode, resizeLayer, translateLayer]
  );

  const onPointerLeave = useMutation((
    { setMyPresence }
  ) => {
    setMyPresence({ cursor: null });
  }, []);

  const onPointerDown = useCallback((e: React.PointerEvent) => {
    const point = pointerEventToCanvasPoint(e, camera);

    if (canvasState.mode === BoardCanvasMode.Inserting) {
      return
    }
    // TODO: add case for draw

    setCanvasState({ origin: point, mode: BoardCanvasMode.Pressing });
  }, [camera, canvasState.mode, setCanvasState]);

  const onPointerUp = useMutation(({}, e) => {
    const point = pointerEventToCanvasPoint(e, camera);
    
    if (canvasState.mode === BoardCanvasMode.None || canvasState.mode === BoardCanvasMode.Pressing) {
      unselectLayer();
      setCanvasState({ mode: BoardCanvasMode.None });
      return;
    } else if (canvasState.mode === BoardCanvasMode.Inserting) {
      insertLayer(canvasState.layerType, point);
    } else {
      setCanvasState({ mode: BoardCanvasMode.None });
    }

    history.resume();
  }, [canvasState, camera, history, insertLayer, unselectLayer]);

  const selections = useOthersMapped((other) => other.presence.selection);

  const layersIdsToColorSelect = useMemo(() => {
    const layersIdsToColorSelect: Record<string,string> = {}
    for (const user of selections) {
      const [connectionId, selection] = user;

      for (const layerId of selection) {
        layersIdsToColorSelect[layerId] = connectionIdToColor(connectionId);
      }
    }

    return layersIdsToColorSelect
  }, [layerIds, selections]);

  const onLayerPointerDown = useMutation((
    { self, setMyPresence },
    e: React.PointerEvent,
    layerId: string
  ) => {
    if (canvasState.mode === BoardCanvasMode.Pencil || canvasState.mode === BoardCanvasMode.Inserting) {
      return;
    } 

    history.pause();
    e.stopPropagation();

    const point = pointerEventToCanvasPoint(e, camera);

    if (!self.presence.selection.includes(layerId)) {
      setMyPresence({ selection: [layerId] }, { addToHistory: true });
    }

    setCanvasState({ mode: BoardCanvasMode.Translating, current: point });
  }, [setCanvasState, camera, history, canvasState.mode]);


  useEffect(() => {
  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      setCanvasState({ mode: BoardCanvasMode.None });
      unselectLayer();
    }
  };
  window.addEventListener('keydown', handleKeyDown);
  return () => {
    window.removeEventListener('keydown', handleKeyDown);
  };
}, [unselectLayer, setCanvasState]);

  return (
    <main className="h-full w-full relative bg-neutral touch-none">
      <BoardInfo boardId={boardId} />
      <BoardParticipants />

      <BoardToolbar
        canvasState={canvasState}
        setCanvasState={setCanvasState}
        undo={history.undo}
        redo={history.redo}
        canUndo={canUndo}
        canRedo={canRedo}
      />
      <SelectionTools
        camera={camera}
        setLastUsedColor={setLastUsedColor}
      />
      <svg
        className="h-[100vh] w-[100vw]"
        onWheel={onWheel}
        onPointerMove={onPointerMove}
        /* TODO: fix onPointerLeave={onPointerLeave} */
        onPointerLeave={onPointerLeave}
        onPointerDown={onPointerDown}
        onPointerUp={onPointerUp}
      >
        <g style={{ transform: `translate(${camera.x}px, ${camera.y}px)`}}>
          {layerIds.map((layerId) => (
            <LayerPreview 
              key={layerId} 
              id={layerId}
              onLayerPointerDown={onLayerPointerDown}
              selectionColor={layersIdsToColorSelect[layerId]}
            />
          ))}
          <SelectionBox
           onResizeHandlePointerDown={onResizeHandlePointerDown}
          />
          <CursorsPresence />
        </g>
      </svg>
    </main>
  );
};
