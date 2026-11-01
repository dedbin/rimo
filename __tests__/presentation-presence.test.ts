import { describe, expect, it } from "vitest";

import { AwarenessGuard } from "@/collaboration-server/awareness";
import type { CollaborationContext } from "@/collaboration-server/types";
import { emptyPresence, parseParticipant } from "@/lib/collaboration/presence";
import { cameraFromPresentation, parseLaserPresence, parsePresentationCamera, presentationFromCamera, resolveFollowCamera } from "@/lib/collaboration/presentation";
import type { PresentationCamera } from "@/lib/collaboration/presentation";

const camera: PresentationCamera = { center: { x: 200, y: -400 }, scale: 2, following: null };
const laser = { sequence: 4, points: [{ x: 10, y: -20 }, { x: 30, y: 40 }] };
const context: CollaborationContext = { boardId: "board", userId: "user", name: "Анна", sessionId: "session", reservationId: "connection", role: "viewer" };
const participant = (connectionId: number, following: number | null) => ({ connectionId,
  presence: { camera: { ...camera, following } } });

describe("presentation presence boundaries", () => {
  it("preserves camera, laser and a transparent remote draft through both server and client parsers", () => {
    const guard = new AwarenessGuard();
    const states = new Map<number, Record<string, unknown>>([[17, { user: { name: "forged" }, presence: {
      ...emptyPresence(), camera, laser, penColor: { r: 59, g: 130, b: 246, a: 0.25 },
    } }]]);
    guard.filter(context, states, new Set());
    const parsed = parseParticipant(17, states.get(17)!);
    expect(parsed?.info.name).toBe("Анна");
    expect(parsed?.presence).toMatchObject({ camera, laser, penColor: { r: 59, g: 130, b: 246, a: 0.25 } });
  });

  it("rejects unbounded and non-finite presentation payloads consistently", () => {
    for (const invalid of [{ ...camera, scale: 0 }, { ...camera, scale: 4.1 }, { ...camera, following: -1 },
      { ...camera, center: { x: Infinity, y: 0 } }, { ...camera, center: { x: 10_000_001, y: 0 } }]) {
      expect(parsePresentationCamera(invalid)).toBeNull();
    }
    for (const invalid of [{ ...laser, sequence: 0 }, { ...laser, sequence: 1.5 }, { ...laser, points: [] },
      { ...laser, points: Array.from({ length: 33 }, () => ({ x: 0, y: 0 })) },
      { ...laser, points: [{ x: NaN, y: 0 }] }]) expect(parseLaserPresence(invalid)).toBeNull();
    const states = new Map<number, Record<string, unknown>>([[17, { presence: { camera: { ...camera, scale: Infinity }, laser: { ...laser, sequence: -2 } } }]]);
    new AwarenessGuard().filter(context, states, new Set());
    expect(parseParticipant(17, states.get(17)!)?.presence).toMatchObject({ camera: null, laser: null });
  });

  it("keeps old presence compatible and drops a malformed pen alpha", () => {
    const old = parseParticipant(17, { user: { name: "Old" }, presence: emptyPresence() });
    expect(old?.presence).toEqual(emptyPresence());
    const malformed = parseParticipant(17, { user: { name: "Old" }, presence: { ...emptyPresence(), penColor: { r: 0, g: 0, b: 0, a: Infinity } } });
    expect(malformed?.presence.penColor).toBeNull();
  });
});

describe("camera following geometry", () => {
  it("keeps the board-space center and scale across unequal viewports", () => {
    const presentation = presentationFromCamera({ x: -200, y: 100, scale: 2 }, { width: 1200, height: 800 }, null);
    expect(presentation).toEqual({ center: { x: 400, y: 150 }, scale: 2, following: null });
    expect(cameraFromPresentation(presentation, { width: 600, height: 400 })).toEqual({ x: -500, y: -100, scale: 2 });
  });

  it("resolves the terminal leader and blocks self-follow, loops and departed targets", () => {
    const leader = participant(3, null);
    expect(resolveFollowCamera(1, 2, [participant(2, 3), leader])).toEqual(leader.presence.camera);
    expect(resolveFollowCamera(1, 1, [leader])).toBeNull();
    expect(resolveFollowCamera(1, 2, [participant(2, 1)])).toBeNull();
    expect(resolveFollowCamera(1, 2, [participant(2, 3), participant(3, 2)])).toBeNull();
    expect(resolveFollowCamera(1, 2, [participant(2, 99)])).toBeNull();
  });
});
