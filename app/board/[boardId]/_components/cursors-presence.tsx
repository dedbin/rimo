"use client";

import { memo } from "react";
import { useOthersConnectionIds } from "@liveblocks/react/suspense";
import { Cursor } from "./cursor";

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

export const CursorsPresence = memo(() => {
    return (
        <>
            {/* todo: draft pencil*/}
            <Cursors/>
        </>
    );
});

CursorsPresence.displayName = "CursorsPresence";