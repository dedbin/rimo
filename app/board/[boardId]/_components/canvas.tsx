"use client";

import { BoardInfo } from "./info";
import { BoardParticipants } from "./participants";
import { BoardToolbar } from "./toolbar";
interface BoardCanvasProps {
    boardId: string;
}

export const BoardCanvas = ({boardId}: BoardCanvasProps) => {
    
    return (
        <main className="h-full w-full relative bg-neutral touch-none">
            <BoardInfo boardId={boardId}/>
            <BoardParticipants />
            <BoardToolbar/>
        </main>
    )
};