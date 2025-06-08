"use client";

import { ReactNode } from "react";
import {
  LiveblocksProvider,
  RoomProvider,
  ClientSideSuspense,
} from "@liveblocks/react/suspense";
import { LiveMap, LiveObject, LiveList } from "@liveblocks/client";
import { Layer } from "@/types/board-canvas";

interface RoomProps {
  children: ReactNode;
    roomId: string;
    fallback: ReactNode;
}

export function Room({ children, roomId, fallback}: RoomProps) {
  return (
    <LiveblocksProvider throttle={16} authEndpoint={"/api/liveblocks-auth"}>
      <RoomProvider 
        id={roomId} 
        initialPresence={{
          cursor: null,
          selection: [],
          pencilDraft: null,
          penColor: null,
          penSize: 16,
          eraserDraft: null // TODO: implement eraser draft

        }}
        initialStorage={{
          layers: new LiveMap<string, LiveObject<Layer>>(),
          layerIds: new LiveList<string>([])
        }}
      >
        <ClientSideSuspense fallback={fallback}>
          {children}
        </ClientSideSuspense>
      </RoomProvider>
    </LiveblocksProvider>
  );
}