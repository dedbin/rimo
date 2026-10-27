import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HocuspocusProviderConfiguration } from "@hocuspocus/provider";
import { WebSocketStatus } from "@hocuspocus/provider";
import * as Y from "yjs";
import { BoardRuntime } from "@/lib/collaboration/runtime";
import { createLayer } from "@/lib/board/model";
import { LayerType } from "@/types/board-canvas";
import type { BoardSession } from "@/types/service";

const mocked = vi.hoisted(() => ({ options: null as HocuspocusProviderConfiguration | null }));
vi.mock("@hocuspocus/provider", async (importOriginal) => ({
  ...await importOriginal<typeof import("@hocuspocus/provider")>(),
  WebSocketStatus: { Connected: "connected", Disconnected: "disconnected", Connecting: "connecting" },
  HocuspocusProvider: class {
    configuration = { websocketProvider: { webSocket: null, send: vi.fn() } };
    awareness = { getStates: () => new Map(), on: vi.fn(), off: vi.fn(),
      setLocalState: vi.fn(), setLocalStateField: vi.fn() };
    sendStateless = vi.fn();
    disconnect = vi.fn();
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
const role = (value: BoardSession["role"]) => options().onStateless?.({ payload: JSON.stringify({ type: "access-role", role: value }) });
const acknowledge = () => options().onStateless?.({ payload: JSON.stringify({ type: "persisted",
  revision: 1, savedAt: new Date().toISOString(),
  snapshot: btoa(String.fromCharCode(...Y.encodeSnapshot(Y.snapshot(runtime.board.doc)))),
}) });

beforeEach(() => {
  runtime = new BoardRuntime(session);
  runtime.board.doc.getMap("meta").set("schemaVersion", 2);
  options().onStatus?.({ status: WebSocketStatus.Connected });
  role("owner");
  options().onSynced?.({ state: true });
  acknowledge();
});
afterEach(() => runtime.destroy());

describe("board connection lifecycle", () => {
  it.each([
    ["Board storage limit reached", "storage-limit", "предел размера"],
    ["Board object limit reached", "object-limit", "предел количества объектов"],
  ])("preserves a rejected local draft and blocks replay after logical quota close: %s", (reason, rejection, message) => {
    const beforeDraft = { ...runtime.getState() };
    const previousAck = JSON.stringify({ type: "persisted", revision: beforeDraft.revision, savedAt: beforeDraft.savedAt,
      snapshot: btoa(String.fromCharCode(...Y.encodeSnapshot(Y.snapshot(runtime.board.doc)))) });
    const [id] = runtime.board.insert([createLayer(LayerType.Rectangle, { x: 10, y: 20 }, { r: 0, g: 0, b: 0 })]);
    const draft = Y.encodeStateAsUpdate(runtime.board.doc);
    const listener = vi.fn(() => expect(runtime.board.canEdit).toBe(false));
    const unsubscribe = runtime.subscribeState(listener);
    vi.mocked(runtime.provider.sendStateless).mockClear();
    options().onClose?.({ event: { code: 1000, reason } });
    expect(runtime.getState()).toMatchObject({ writeRejection: rejection, saved: false, pending: true, connected: false, synced: false });
    expect(runtime.getState().error).toContain(message);
    expect(runtime.provider.disconnect).toHaveBeenCalledTimes(1);
    expect(runtime.provider.destroy).not.toHaveBeenCalled();
    options().onStateless?.({ payload: previousAck });
    acknowledge(); // Even an ACK that matches this draft must not erase the terminal rejection.
    options().onStateless?.({ payload: JSON.stringify({ type: "persistence-error", message: "later error" }) });
    options().onStatus?.({ status: WebSocketStatus.Connected });
    role("owner");
    options().onSynced?.({ state: true });
    options().onDisconnect?.({ event: { code: 1006, reason: "" } });
    options().onClose?.({ event: { code: 1000, reason } });
    expect(runtime.getState()).toMatchObject({ writeRejection: rejection, saved: false, pending: true, connected: false, synced: false,
      revision: beforeDraft.revision, savedAt: beforeDraft.savedAt });
    expect(runtime.getState().error).toContain(message);
    expect(runtime.getRole()).toBeNull();
    expect(runtime.provider.disconnect).toHaveBeenCalledTimes(1);
    expect(runtime.provider.sendStateless).not.toHaveBeenCalled();
    expect(runtime.board.insert([createLayer(LayerType.Rectangle, { x: 0, y: 0 }, { r: 0, g: 0, b: 0 })])).toEqual([]);
    runtime.board.undo(); runtime.board.redo();
    expect(runtime.board.getLayer(id)).toMatchObject({ x: 10, y: 20 });
    expect(Y.encodeStateAsUpdate(runtime.board.doc)).toEqual(draft);
    expect(listener).toHaveBeenCalled(); unsubscribe();
  });

  it.each(["Board storage limit reached", "Board object limit reached"].flatMap((reason) =>
    ["authentication", "acl-close"].map((denial) => [reason, denial])))("keeps ACL denial ahead of the earlier quota rejection: %s / %s", (reason, denial) => {
    runtime.board.insert([createLayer(LayerType.Rectangle, { x: 0, y: 0 }, { r: 0, g: 0, b: 0 })]);
    const draft = Y.encodeStateAsUpdate(runtime.board.doc);
    options().onClose?.({ event: { code: 1000, reason } });
    if (denial === "authentication") options().onAuthenticationFailed?.({ reason: "Access denied" });
    else options().onClose?.({ event: { code: 1000, reason: "Access revoked or unavailable" } });
    const denied = runtime.getState().error;
    expect(denied).toContain("Доступ");
    options().onClose?.({ event: { code: 1000, reason } });
    acknowledge();
    options().onStatus?.({ status: WebSocketStatus.Connected }); role("owner"); options().onSynced?.({ state: true });
    expect(runtime.getState()).toMatchObject({ error: denied, writeRejection: null, saved: false, pending: true, connected: false, synced: false });
    expect(runtime.getRole()).toBeNull(); expect(runtime.board.canEdit).toBe(false);
    expect(Y.encodeStateAsUpdate(runtime.board.doc)).toEqual(draft);
  });

  it.each(["Board storage limit reached", "Board object limit reached"])("does not mask an ACL close with a late quota callback: %s", (reason) => {
    options().onClose?.({ event: { code: 1000, reason: "Access revoked or unavailable" } });
    options().onClose?.({ event: { code: 1000, reason } });
    acknowledge(); role("owner");
    expect(runtime.getState()).toMatchObject({ writeRejection: null, saved: false });
    expect(runtime.getState().error).toContain("Доступ");
    expect(runtime.getRole()).toBeNull(); expect(runtime.board.canEdit).toBe(false);
    expect(runtime.provider.disconnect).not.toHaveBeenCalled();
  });

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
    expect(runtime.board.canEdit).toBe(false);
    role("owner");
    expect(runtime.board.canEdit).toBe(true);
    expect(runtime.getState().pending).toBe(true);
    acknowledge();
    expect(runtime.getState()).toMatchObject({ saved: true, pending: false });
  });

  it("does not report remote uncommitted changes as local pending edits", () => {
    runtime.board.doc.getMap("meta").set("remoteRevision", 2);
    expect(runtime.getState()).toMatchObject({ saved: false, pending: false });
  });

  it("requires an authoritative role after synchronization, including a stale HTTP editor session", () => {
    runtime.destroy();
    runtime = new BoardRuntime({ ...session, role: "editor" });
    runtime.board.doc.getMap("meta").set("schemaVersion", 2);
    options().onStatus?.({ status: WebSocketStatus.Connected });
    options().onSynced?.({ state: true });
    acknowledge();
    expect(runtime.getRole()).toBeNull();
    expect(runtime.board.canEdit).toBe(false);
    role("viewer");
    expect(runtime.getRole()).toBe("viewer");
    expect(runtime.board.canEdit).toBe(false);
    expect(runtime.session.role).toBe("editor");
  });

  it("accepts a role before sync but keeps writes locked until both are ready", () => {
    options().onDisconnect?.({ event: { code: 1006, reason: "" } });
    options().onStatus?.({ status: WebSocketStatus.Connected });
    role("editor");
    expect(runtime.board.canEdit).toBe(false);
    options().onSynced?.({ state: true });
    expect(runtime.board.canEdit).toBe(true);
  });

  it("demotes and promotes without mutating the session input or changing persistence state", () => {
    const original = runtime.getState();
    const listener = vi.fn();
    const unsubscribe = runtime.subscribeState(listener);
    role("viewer");
    expect(runtime.board.canEdit).toBe(false);
    expect(runtime.getRole()).toBe("viewer");
    expect(runtime.getState()).toEqual(original);
    acknowledge();
    expect(runtime.board.canEdit).toBe(false);
    role("editor");
    expect(runtime.board.canEdit).toBe(true);
    expect(runtime.getRole()).toBe("editor");
    expect(runtime.session).toBe(session);
    expect(session.role).toBe("owner");
    expect(listener).toHaveBeenCalledTimes(3);
    unsubscribe();
  });

  it.each(["Access revoked or unavailable", "Board removed", "This board is read-only"])("never reopens writes after a terminal close: %s", (reason) => {
    options().onClose?.({ event: { code: 1000, reason } });
    role("owner");
    acknowledge();
    options().onStatus?.({ status: WebSocketStatus.Connected });
    role("editor");
    options().onSynced?.({ state: true });
    expect(runtime.board.canEdit).toBe(false);
    expect(runtime.getRole()).toBeNull();
    expect(runtime.getState().error).toContain("Доступ");
  });

  it("does not let a role snapshot clear persistence errors, and recovers only on a valid ACK", () => {
    options().onStateless?.({ payload: JSON.stringify({ type: "persistence-error", message: "Запись недоступна" }) });
    role("editor");
    expect(runtime.board.canEdit).toBe(false);
    expect(runtime.getState().error).toBe("Запись недоступна");
    acknowledge();
    expect(runtime.board.canEdit).toBe(true);
  });

  it("ignores malformed or late disconnected role snapshots", () => {
    role("viewer");
    options().onStateless?.({ payload: JSON.stringify({ type: "access-role", role: "admin" }) });
    expect(runtime.getRole()).toBe("viewer");
    expect(runtime.board.canEdit).toBe(false);
    options().onDisconnect?.({ event: { code: 1006, reason: "" } });
    role("editor");
    expect(runtime.getRole()).toBeNull();
    expect(runtime.board.canEdit).toBe(false);
  });
});
