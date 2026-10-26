"use client";

import { memo } from "react";
import { useOthers } from "@/lib/collaboration/react";
import { Cursor } from "./cursor";
import { Path } from "./path";
import { rgbToCss } from "@/lib/utils";

const Cursors = () => {
  const others = useOthers();
  return (
    <>
      {others.map((participant) => (
        <Cursor key={participant.connectionId} participant={participant} />
      ))}
    </>
  );
};

const Drafts = () => {
  const others = useOthers();

  return (
    <>
      {others.map(({ connectionId, presence: other }) => {
        if (!other.pencilDraft) return null;
        return (
          <Path
            key={connectionId}
            points={other.pencilDraft}
            x={0}
            y={0}
            fill={other.penColor ? rgbToCss(other.penColor) : "#000"}
            size={other.penSize ?? 16}    
          />
        );
      })}
    </>
  );
};

export const CursorsPresence = memo(() => {
  return (
    <>
      <Drafts />
      <Cursors />
    </>
  );
});

CursorsPresence.displayName = "CursorsPresence";
