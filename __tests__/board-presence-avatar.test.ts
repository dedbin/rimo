// @vitest-environment node
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { applyAwarenessUpdate, Awareness, encodeAwarenessUpdate } from "y-protocols/awareness";

import { AwarenessGuard } from "@/collaboration-server/awareness";
import type { CollaborationContext } from "@/collaboration-server/types";
import { emptyPresence, parseParticipant, type BoardParticipant } from "@/lib/collaboration/presence";

function avatarThroughAwareness(image?: string): BoardParticipant | null {
  const sourceDoc = new Y.Doc();
  const receiverDoc = new Y.Doc();
  sourceDoc.clientID = 101;
  receiverDoc.clientID = 102;
  const source = new Awareness(sourceDoc);
  const receiver = new Awareness(receiverDoc);
  const guard = new AwarenessGuard();
  const context: CollaborationContext = {
    boardId: "board", userId: "peer", sessionId: "session", reservationId: "connection",
    name: "Анна", role: "editor", ...(image !== undefined ? { image } : {}),
  };
  try {
    const states = new Map<number, Record<string, unknown>>([[sourceDoc.clientID, {
      presence: { ...emptyPresence(), cursor: { x: 15, y: 20 }, selection: ["layer"],
        drag: { ids: ["layer"], delta: { x: 2, y: 3 } } },
    }]]);
    guard.filter(context, states, new Set());
    source.setLocalState(states.get(sourceDoc.clientID)!);
    applyAwarenessUpdate(receiver, encodeAwarenessUpdate(source, [sourceDoc.clientID]), "test");
    return parseParticipant(sourceDoc.clientID, receiver.getStates().get(sourceDoc.clientID)!);
  } finally {
    guard.release(context);
    source.destroy();
    receiver.destroy();
    sourceDoc.destroy();
    receiverDoc.destroy();
  }
}

describe("peer avatar awareness roundtrip", () => {
  it("preserves every bundled avatar and local asset through the server guard, wire and peer parser", () => {
    const paths = [...Array.from({ length: 10 }, (_value, index) => `/avatars/avatar_${index}.svg`),
      "/api/assets/12345678-1234-4abc-8def-123456789abc", "/api/assets/12345678-1234-4ABC-8DEF-123456789ABC"];
    for (const picture of paths) {
      const participant = avatarThroughAwareness(picture);
      expect(participant?.info, picture).toEqual({ id: "peer", name: "Анна", picture });
      expect(participant?.presence).toEqual({ ...emptyPresence(), cursor: { x: 15, y: 20 }, selection: ["layer"],
        drag: { ids: ["layer"], delta: { x: 2, y: 3 } } });
    }
  });

  it("drops foreign, data and malformed local avatar URLs while retaining the participant", () => {
    for (const picture of [
      "https://tracker.example/avatar.png", "http://tracker.example/avatar.png", "//tracker.example/avatar.png",
      "data:image/svg+xml,<svg/>", String.raw`/\tracker.example/avatar.png`, "/%5ctracker.example/avatar.png",
      "/avatars/%61vatar_0.svg", "/avatars/avatar_0.svg\n", "/avatars/avatar_10.svg",
      "/api/assets/not-a-uuid", "/api/assets/12345678-1234-4abc-8def-123456789abc?url=https://tracker.example",
    ]) {
      const participant = avatarThroughAwareness(picture);
      expect(participant?.info, picture).toEqual({ id: "peer", name: "Анна" });
      expect(participant?.presence.selection).toEqual(["layer"]);
    }
    expect(avatarThroughAwareness()?.info).toEqual({ id: "peer", name: "Анна" });
  });
});
