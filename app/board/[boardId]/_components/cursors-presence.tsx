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
        <Cursor key={connectionId} connectionId={connectionId} />
      ))}
    </>
  );
};

const Drafts = () => {
  // Теперь подтягиваем и penSize из presence
  const others = useOthersMapped(
    (other) => ({
      pencilDraft: other.presence.pencilDraft,
      penColor: other.presence.penColor,
      penSize:  other.presence.penSize,    // <-- добавили
    }),
    shallow
  );

  return (
    <>
      {others.map(([key, other]) => {
        if (!other.pencilDraft) return null;
        return (
          <Path
            key={key}
            points={other.pencilDraft}
            x={0}
            y={0}
            fill={other.penColor ? rgbToCss(other.penColor) : "#000"}
            size={other.penSize ?? 16}        // <-- используем размер пера
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