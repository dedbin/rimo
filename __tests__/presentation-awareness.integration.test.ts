// @vitest-environment node
import { randomUUID } from "node:crypto";

import { afterEach, describe, expect, it } from "vitest";
import * as Y from "yjs";

import { cleanupIngress, ingressFixture } from "../collaboration-server/__tests__/ingress-fixture";
import { waitFor } from "../collaboration-server/__tests__/helpers";
import { emptyPresence, parseParticipant } from "../lib/collaboration/presence";

afterEach(cleanupIngress);

describe("presentation through the real WebSocket awareness guard", () => {
  it("transmits a viewer camera and laser without writing the shared document", async () => {
    const context = await ingressFixture();
    const boardId = randomUUID();
    const viewer = context.provider(boardId, "viewer");
    const writer = context.provider(boardId, "writer");
    await writer.connect();
    await viewer.connect();
    const original = Y.encodeStateAsUpdate(writer.document);
    const peer = () => parseParticipant(viewer.document.clientID,
      writer.provider.awareness!.getStates().get(viewer.document.clientID) ?? {});
    const camera = { center: { x: -120, y: 720 }, scale: 1.5, following: writer.document.clientID };
    const laser = { sequence: 10, points: [{ x: 20, y: 40 }, { x: 50, y: 60 }] };
    viewer.provider.awareness!.setLocalState({ user: { name: "forged" }, presence: { ...emptyPresence(),
      camera, laser, penColor: { r: 255, g: 0, b: 0, a: 0.5 } } });
    await waitFor(() => peer()?.presence.laser?.sequence === 10);
    expect(peer()?.presence).toMatchObject({ camera, laser, penColor: { r: 255, g: 0, b: 0, a: 0.5 } });
    expect(peer()?.info.name).toBe("viewer");
    expect(Y.encodeStateAsUpdate(writer.document)).toEqual(original);
    viewer.provider.awareness!.setLocalStateField("presence", { ...emptyPresence(), camera, laser: null });
    await waitFor(() => peer()?.presence.laser === null);
    expect(Y.encodeStateAsUpdate(writer.document)).toEqual(original);
  });
});
