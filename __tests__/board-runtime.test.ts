import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HocuspocusProviderConfiguration } from "@hocuspocus/provider";
import { WebSocketStatus } from "@hocuspocus/provider";
import * as Y from "yjs";
import { BoardRuntime } from "@/lib/collaboration/runtime";
import { createLayer } from "@/lib/board/model";
import { LayerType } from "@/types/board-canvas";
import type { BoardSession } from "@/types/service";

const mocked = vi.hoisted(() => ({ options: null as HocuspocusProviderConfiguration | null }));
vi.mock("@hocuspocus/provider", () => ({
  WebSocketStatus: { Connected: "connected", Disconnected: "disconnected", Connecting: "connecting" },
  HocuspocusProvider: class {
    awareness = { getStates: () => new Map(), on: vi.fn(), off: vi.fn(),
      setLocalState: vi.fn(), setLocalStateField: vi.fn() };
    sendStateless = vi.fn();
    destroy = vi.fn();
    constructor(options: HocuspocusProviderConfiguration) { mocked.options = options; }
  },
}));

const session: BoardSession = {
  role: "owner", user: { id: "user", name: "Владелец" },
  connection: { url: "ws://localhost/collaboration", token: "cookie" },
  board: { id: "board", title: "Доска", ownerId: "user", authorName: "Владелец", imageUrl: "",
    createdAt: 0, updatedAt: 0, isFavorite: false, role: "owner" },
};
let runtime: BoardRuntime;
const options = () => mocked.options!;
const acknowledge = () => options().onStateless?.({ payload: JSON.stringify({ type: "persisted",
  revision: 1, savedAt: new Date().toISOString(),
  snapshot: btoa(String.fromCharCode(...Y.encodeSnapshot(Y.snapshot(runtime.board.doc)))),
}) });

beforeEach(() => {
  runtime = new BoardRuntime(session);
  runtime.board.doc.getMap("meta").set("schemaVersion", 1);
  options().onStatus?.({ status: WebSocketStatus.Connected });
  options().onSynced?.({ state: true });
  acknowledge();
});
afterEach(() => runtime.destroy());

describe("board connection lifecycle", () => {
  it("locks edits and explains a logical ACL close with code 1000", () => {
    options().onClose?.({ event: { code: 1000, reason: "Access revoked or unavailable" } });
    expect(runtime.board.canEdit).toBe(false);
    expect(runtime.getState()).toMatchObject({ connected: false, synced: false });
    expect(runtime.getState().error).toContain("Доступ");
    acknowledge();
    expect(runtime.board.canEdit).toBe(false);
    expect(runtime.getState().error).toContain("Доступ");
  });

  it("blocks new edits offline and preserves the pending warning until a commit acknowledgement", () => {
    runtime.board.insert([createLayer(LayerType.Rectangle, { x: 0, y: 0 }, { r: 0, g: 0, b: 0 })]);
    expect(runtime.getState().pending).toBe(true);
    options().onDisconnect?.({ event: { code: 1006, reason: "" } });
    expect(runtime.board.canEdit).toBe(false);
    expect(runtime.getState()).toMatchObject({ synced: false, pending: true, saved: false });
    options().onStatus?.({ status: WebSocketStatus.Connected });
    options().onSynced?.({ state: true });
    expect(runtime.board.canEdit).toBe(true);
    expect(runtime.getState().pending).toBe(true);
    acknowledge();
    expect(runtime.getState()).toMatchObject({ saved: true, pending: false });
  });

  it("does not report remote uncommitted changes as local pending edits", () => {
    runtime.board.doc.getMap("meta").set("remoteRevision", 2);
    expect(runtime.getState()).toMatchObject({ saved: false, pending: false });
  });
});
