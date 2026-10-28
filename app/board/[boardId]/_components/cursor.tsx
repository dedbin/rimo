"use client";

import { memo } from "react";
import { connectionIdToColor } from "@/lib/utils";
import { MousePointer2 } from "lucide-react";
import { BoardParticipant } from "@/lib/collaboration/presence";

interface CursorProps {
    participant: BoardParticipant;
}

export const Cursor = memo(({participant}: CursorProps) => {
    const { connectionId, info, presence: { cursor } } = participant;
    const name = info.name || "Гость";

    if (!cursor) return null;

    const {x, y} = cursor;

    return (
        <foreignObject 
            style={{transform: `translateX(${x}px) translateY(${y}px)`}} 
            height={50} 
            width={name.length * 10+24} 
            className="relative drop-shadow-md"
        >
            <MousePointer2 
                className="w-5 h-5" 
                style={{
                    fill: connectionIdToColor(connectionId),
                    color: connectionIdToColor(connectionId),
                }}
            />
            <span className="absolute px-1.5 py-0.5 left-5 rounded-md text-white select-none pointer-events-none text-xs font-semibold" style={{background: connectionIdToColor(connectionId)}}>{name}</span>
        </foreignObject>
    )
})

Cursor.displayName = "Cursor";
