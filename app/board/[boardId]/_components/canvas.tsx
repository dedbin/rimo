"use client";

import { use, useEffect, useState } from "react";
import { BoardCanvasState, BoardCanvasMode } from "@/types/board-canvas";

import { BoardInfo } from "./info";
import { BoardParticipants } from "./participants";
import { BoardToolbar } from "./toolbar";
import { useHistory, useCanRedo, useCanUndo } from "@liveblocks/react/suspense";
interface BoardCanvasProps {
    boardId: string;
}

export const BoardCanvas = ({boardId}: BoardCanvasProps) => {
    
    const [canvasState, setCanvasState] = useState<BoardCanvasState>({mode: BoardCanvasMode.None});

    const history = useHistory();
    const canUndo = useCanUndo();
    const canRedo = useCanRedo();
    return (
        <main className="h-full w-full relative bg-neutral touch-none">
            <BoardInfo boardId={boardId}/>
            <BoardParticipants />
            <BoardToolbar
                canvasState={canvasState}
                setCanvasState={setCanvasState}
                undo={history.undo}
                redo={history.redo}
                canUndo={canUndo}
                canRedo={canRedo}
            />
        </main>
    )
};