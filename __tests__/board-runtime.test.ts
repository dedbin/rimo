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
