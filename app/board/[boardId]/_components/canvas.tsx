"use client";

import { BoardInfo } from "./info";
import { BoardParticipants } from "./participants";
import { BoardToolbar } from "./toolbar";
import { useSelf } from "@liveblocks/react/suspense";

interface BoardCanvasProps {
    boardId: string;
}

export const BoardCanvas = ({boardId}: BoardCanvasProps) => {
    const info = useSelf((me) => me.info);
    console.log(info);
    return (
        <main className="h-full w-full relative bg-neutral touch-none">
            <BoardInfo />
            <BoardParticipants />
            <BoardToolbar/>
        </main>
    )
};