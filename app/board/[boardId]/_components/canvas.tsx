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
} from "@liveblocks/react/suspense";
import { CursorsPresence } from "./cursors-presence";
import { pointerEventToCanvasPoint } from "@/lib/utils";

interface BoardCanvasProps {
  boardId: string;
}

export const BoardCanvas = ({ boardId }: BoardCanvasProps) => {
  const [canvasState, setCanvasState] = useState<BoardCanvasState>({
    mode: BoardCanvasMode.None,
  });

  const [camera, setCamera] = useState<Camera>({ x: 0, y: 0 });
  const cameraRef = useRef<Camera>(camera);
  const rafRef = useRef<number | null>(null);

  const history = useHistory();
  const canUndo = useCanUndo();
  const canRedo = useCanRedo();

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
        /* todo: fix onPointerLeave={onPointerLeave} */
        onPointerLeave={onPointerLeave}
      >
        <g>
          <CursorsPresence />
        </g>
      </svg>
    </main>
  );
};
