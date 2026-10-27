import type { PointerEvent, ReactNode } from "react";
import { act, cleanup, render, renderHook, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HocuspocusProviderConfiguration } from "@hocuspocus/provider";
import { WebSocketStatus } from "@hocuspocus/provider";
import * as Y from "yjs";

import { BoardCanvas } from "@/app/board/[boardId]/_components/canvas";
import { useCanvasGestures } from "@/app/board/[boardId]/_hooks/use-canvas-gestures";
import { createLayer } from "@/lib/board/model";
import { BoardRuntimeContext } from "@/lib/collaboration/react";
import { BoardRuntime } from "@/lib/collaboration/runtime";
import { BoardCanvasMode, LayerType } from "@/types/board-canvas";
import type { BoardSession } from "@/types/service";

const mocked = vi.hoisted(() => ({ options: null as HocuspocusProviderConfiguration | null }));
vi.mock("@hocuspocus/provider", () => ({
  WebSocketStatus: { Connected: "connected" },
  HocuspocusProvider: class {
    awareness = { getStates: () => new Map(), on: vi.fn(), off: vi.fn(), setLocalState: vi.fn(), setLocalStateField: vi.fn() };
    sendStateless = vi.fn(); disconnect = vi.fn(); destroy = vi.fn();
    constructor(options: HocuspocusProviderConfiguration) { mocked.options = options; }
  },
}));
// Keep the real canvas/loading guard, runtime hooks, save status, and gesture cancellation.
vi.mock("@/app/board/[boardId]/_components/info", () => ({ BoardInfo: () => <nav aria-label="Информация о доске" /> }));
vi.mock("@/app/board/[boardId]/_components/participants", () => ({ BoardParticipants: () => null }));
vi.mock("@/app/board/[boardId]/_components/toolbar", () => ({ BoardToolbar: () => <button>Инструменты редактирования</button> }));
vi.mock("@/app/board/[boardId]/_components/selection-tools", () => ({ SelectionTools: () => null }));
vi.mock("@/app/board/[boardId]/_components/text-selection-tools", () => ({ TextSelectionTools: () => null }));
vi.mock("@/app/board/[boardId]/_components/session-timer", () => ({ SessionTimer: () => null }));
vi.mock("@/app/board/[boardId]/_components/zoom-controls", () => ({ ZoomControls: () => null }));
vi.mock("@/app/board/[boardId]/_components/canvas-loading", () => ({ CanvasLoading: () => <div data-testid="canvas-loading">Подключение</div> }));
vi.mock("@/components/board-text/styles.module.css", () => ({ default: { content: "content" } }));
vi.mock("katex/dist/katex.min.css", () => ({}));

const session: BoardSession = { role: "owner", user: { id: "owner", name: "Владелец" },
  connection: { url: "ws://localhost/collaboration", token: "cookie" },
  board: { id: "board", role: "owner", ownerId: "owner", title: "Доска", authorName: "Владелец", imageUrl: "",
    createdAt: 0, updatedAt: 0, isFavorite: false } };
const runtimes: BoardRuntime[] = [];
const reasons = ["Board storage limit reached", "Board object limit reached"];
const role = () => mocked.options!.onStateless?.({ payload: JSON.stringify({ type: "access-role", role: "owner" }) });
const acknowledge = (current: BoardRuntime) => mocked.options!.onStateless?.({ payload: JSON.stringify({ type: "persisted", revision: 1,
  savedAt: new Date().toISOString(), snapshot: btoa(String.fromCharCode(...Y.encodeSnapshot(Y.snapshot(current.board.doc)))) }) });

function readyRuntime() {
  const current = new BoardRuntime(session); runtimes.push(current);
  current.board.doc.getMap("meta").set("schemaVersion", 2);
  mocked.options!.onStatus?.({ status: WebSocketStatus.Connected }); role(); mocked.options!.onSynced?.({ state: true }); acknowledge(current);
  return current;
}
afterEach(() => { cleanup(); runtimes.splice(0).forEach((current) => current.destroy()); vi.unstubAllGlobals(); });

describe("write rejection recovery UI", () => {
  it.each(reasons)("leaves the draft canvas visible and opens the saved version in a new tab: %s", (reason) => {
    const current = readyRuntime();
    current.board.insert([createLayer(LayerType.Rectangle, { x: 10, y: 20 }, { r: 0, g: 0, b: 0 })]);
    const doc = current.board.doc; const draft = Y.encodeStateAsUpdate(doc);
    const result = render(<BoardRuntimeContext.Provider value={current}><BoardCanvas boardId={session.board.id} /></BoardRuntimeContext.Provider>);
    expect(screen.getByRole("button", { name: "Инструменты редактирования" })).toBeTruthy();
    act(() => mocked.options!.onClose?.({ event: { code: 1000, reason } }));
    expect(screen.getByRole("alert").textContent).toContain("Последние изменения не сохранены");
    expect(screen.getByText(/Черновик остаётся в этой вкладке/)).toBeTruthy();
    const link = screen.getByRole("link", { name: "Открыть сохранённую версию" });
    expect(link.getAttribute("href")).toBe("/board/board");
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toBe("noopener noreferrer");
    expect(screen.queryByTestId("canvas-loading")).toBeNull();
    expect(result.container.querySelector(".absolute.inset-0.z-20")).toBeNull();
    expect(screen.getByLabelText("Холст доски").querySelector("rect.drop-shadow-md")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Инструменты редактирования" })).toBeNull();
    act(() => {
      acknowledge(current); mocked.options!.onStatus?.({ status: WebSocketStatus.Connected }); role(); mocked.options!.onSynced?.({ state: true });
    });
    expect(screen.queryByText("Сохранено", { exact: true })).toBeNull();
    expect(screen.getByRole("alert").getAttribute("data-save-state")).toBe("pending");
    expect(screen.queryByTestId("canvas-loading")).toBeNull();
    expect(screen.getByRole("link", { name: "Открыть сохранённую версию" })).toBe(link);
    expect(current.board.doc).toBe(doc); expect(doc.isDestroyed).toBe(false);
    expect(Y.encodeStateAsUpdate(doc)).toEqual(draft);
    expect(current.getRole()).toBeNull(); expect(current.board.canEdit).toBe(false);
    expect(current.provider.disconnect).toHaveBeenCalledTimes(1);
  });

  it.each(reasons)("withdraws quota recovery when authentication is revoked: %s", (reason) => {
    const current = readyRuntime();
    current.board.insert([createLayer(LayerType.Rectangle, { x: 10, y: 20 }, { r: 0, g: 0, b: 0 })]);
    const draft = Y.encodeStateAsUpdate(current.board.doc);
    render(<BoardRuntimeContext.Provider value={current}><BoardCanvas boardId={session.board.id} /></BoardRuntimeContext.Provider>);
    act(() => mocked.options!.onClose?.({ event: { code: 1000, reason } }));
    expect(screen.getByRole("link", { name: "Открыть сохранённую версию" })).toBeTruthy();
    act(() => {
      mocked.options!.onAuthenticationFailed?.({ reason: "Access denied" });
      mocked.options!.onClose?.({ event: { code: 1000, reason } });
      acknowledge(current); role(); mocked.options!.onStatus?.({ status: WebSocketStatus.Connected }); mocked.options!.onSynced?.({ state: true });
    });
    expect(screen.getByRole("alert").textContent).toContain("Доступ к доске прекращён");
    expect(screen.queryByRole("link", { name: "Открыть сохранённую версию" })).toBeNull();
    expect(screen.queryByText("Сохранено", { exact: true })).toBeNull();
    expect(current.getState()).toMatchObject({ writeRejection: null, pending: true, saved: false });
    expect(current.board.canEdit).toBe(false); expect(current.getRole()).toBeNull();
    expect(Y.encodeStateAsUpdate(current.board.doc)).toEqual(draft);
  });

  it("keeps an ordinary disconnect on the existing reconnect path", () => {
    const current = readyRuntime();
    render(<BoardRuntimeContext.Provider value={current}><BoardCanvas boardId={session.board.id} /></BoardRuntimeContext.Provider>);
    act(() => mocked.options!.onDisconnect?.({ event: { code: 1006, reason: "" } }));
    expect(screen.getByTestId("canvas-loading")).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Открыть сохранённую версию" })).toBeNull();
    expect(current.getState().writeRejection).toBeNull();
    expect(current.provider.disconnect).not.toHaveBeenCalled();
  });

  it.each(reasons)("cancels an active gesture through the central writable gate without dropping the draft: %s", (reason) => {
    vi.stubGlobal("requestAnimationFrame", vi.fn(() => 1)); vi.stubGlobal("cancelAnimationFrame", vi.fn());
    const current = readyRuntime();
    const [id] = current.board.insert([createLayer(LayerType.Rectangle, { x: 10, y: 20 }, { r: 0, g: 0, b: 0 })]);
    const draft = Y.encodeStateAsUpdate(current.board.doc);
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    let captured = false;
    Object.assign(svg, { setPointerCapture: () => { captured = true; }, hasPointerCapture: () => captured,
      releasePointerCapture: vi.fn(() => { captured = false; }), getBoundingClientRect: () => ({ left: 0, top: 0 }) });
    const wrapper = ({ children }: { children: ReactNode }) => <BoardRuntimeContext.Provider value={current}>{children}</BoardRuntimeContext.Provider>;
    const hook = renderHook(() => useCanvasGestures({ svgRef: { current: svg }, cameraRef: { current: { x: 0, y: 0, scale: 1 } },
      updateCamera: vi.fn(), color: { r: 0, g: 0, b: 0 }, penSize: 16 }), { wrapper });
    const pointer = (x: number, y: number) => ({ clientX: x, clientY: y, pressure: 0.5, buttons: 1, button: 0, pointerId: 1,
      currentTarget: svg, preventDefault: vi.fn(), stopPropagation: vi.fn(), shiftKey: false }) as unknown as PointerEvent<SVGSVGElement>;
    act(() => { hook.result.current.onLayerPointerDown(pointer(10, 20), id); hook.result.current.onPointerMove(pointer(50, 60)); });
    expect(svg.hasPointerCapture(1)).toBe(true);
    act(() => mocked.options!.onClose?.({ event: { code: 1000, reason } }));
    expect(hook.result.current.canvasState.mode).toBe(BoardCanvasMode.None);
    expect(hook.result.current.preview.ids).toHaveLength(0);
    expect(svg.releasePointerCapture).toHaveBeenCalledWith(1);
    expect(cancelAnimationFrame).toHaveBeenCalledWith(1);
    act(() => { role(); hook.result.current.onPointerUp(pointer(100, 200)); });
    expect(current.board.getLayer(id)).toMatchObject({ x: 10, y: 20 });
    expect(Y.encodeStateAsUpdate(current.board.doc)).toEqual(draft);
    expect(current.getSelf().presence).toMatchObject({ pencilDraft: null, eraserDraft: null, drag: null });
  });
});
