"use client";

import { memo } from "react";
import { shallow, useOthersConnectionIds, useOthersMapped } from "@liveblocks/react/suspense";
import { Cursor } from "./cursor";
import { Path } from "./path";
import { rgbToCss } from "@/lib/utils";

const Cursors = () => {
    const othersConnectionIds = useOthersConnectionIds();
    return (
        <>
            {othersConnectionIds.map((connectionId) => (
                <Cursor
                    key={connectionId}
                    connectionId={connectionId}
                />
            ))}
        </>
    );
}

const Drafts = () => {
    const others = useOthersMapped((other) => ({
        pencilDraft: other.presence.pencilDraft,
        penColor: other.presence.penColor
    }), shallow);

    return (
        <>
            {others.map(([key, other]) => {
                if (!other.pencilDraft) return null;
                return (
                    <Path
                        key={key}
                        points={other.pencilDraft}
                        fill={other.penColor ? rgbToCss(other.penColor) : "#000"}
                        x={0}
                        y={0}
                    />
                )
            })
            }
        </>
    )
}

export const CursorsPresence = memo(() => {
    return (
        <>
            <Drafts/>
            <Cursors/>
        </>
    );
});

CursorsPresence.displayName = "CursorsPresence";