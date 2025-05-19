"use client";

import {
  useCallback,
  useEffect,
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
import { pointerEventToCanvasPoint } from "@/lib/utils";
import { nanoid } from "nanoid";
import { LiveObject } from "@liveblocks/client";
import { set } from "date-fns";
import { LayerPreview } from "./layer-preview";

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
      width: 100, // todo: maybe make this variable depending on layer type
      fill: lastUsedColor,
    });

    liveLayerIds.push(layerId);
    liveLayers.set(layerId, layer);

    setMyPresence({selection: [layerId],}, { addToHistory: true });
    setCanvasState({ mode: BoardCanvasMode.None });
  }, [lastUsedColor]
);

  const updateMyPresence = useUpdateMyPresence();

  useEffect(() => {
    cameraRef.current = camera;
  }, [camera]);

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

        updateMyPresence(
          { cursor: point },
          { addToHistory: false }
        );

        rafRef.current = null;
      });
    },
    [updateMyPresence]
  );

  const onPointerLeave = useMutation((
    { setMyPresence }
  ) => {
    setMyPresence({ cursor: null });
  }, []);

  const onPointerUp = useMutation(({}, e) => {
    const point = pointerEventToCanvasPoint(e, camera);
    
    // console.log("pointer up", {point, mode: canvasState.mode});
    if (canvasState.mode === BoardCanvasMode.Inserting) {
      insertLayer(canvasState.layerType, point);
    } else {
      setCanvasState({ mode: BoardCanvasMode.None });
    }

    history.resume();
  }, [canvasState, camera, history, insertLayer]);


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

      <svg
        className="h-[100vh] w-[100vw]"
        onWheel={onWheel}
        onPointerMove={onPointerMove}
        /* TODO: fix onPointerLeave={onPointerLeave} */
        onPointerLeave={onPointerLeave}
        onPointerUp={onPointerUp}
      >
        <g style={{ transform: `translate(${camera.x}px, ${camera.y}px)`}}>
          {layerIds.map((layerId) => (
            <LayerPreview 
              key={layerId} 
              id={layerId}
              onLayerPointerDown={() => {}}
              selectionColor={"#000"}
            />
          ))}
          <CursorsPresence />
        </g>
      </svg>
    </main>
  );
};
