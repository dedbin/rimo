import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HocuspocusProviderConfiguration } from "@hocuspocus/provider";
import { WebSocketStatus } from "@hocuspocus/provider";

import { SaveStatus } from "@/app/board/[boardId]/_components/save-status";
import { BoardTextProvider } from "@/components/board-text/provider";
import { RichTextContent } from "@/components/board-text/content";
import { createLayer } from "@/lib/board/model";
import { BoardRuntimeContext, useBoardRole, useBoardRuntime, useConnectionState } from "@/lib/collaboration/react";
import { BoardRuntime } from "@/lib/collaboration/runtime";
import { LayerType } from "@/types/board-canvas";
import type { BoardRole, BoardSession } from "@/types/service";

const mocked = vi.hoisted(() => ({ options: null as HocuspocusProviderConfiguration | null }));
vi.mock("@hocuspocus/provider", () => ({
  WebSocketStatus: { Connected: "connected" },
  HocuspocusProvider: class {
    awareness = { getStates: () => new Map(), on: vi.fn(), off: vi.fn(), setLocalState: vi.fn(), setLocalStateField: vi.fn() };
    sendStateless = vi.fn(); destroy = vi.fn();
    constructor(options: HocuspocusProviderConfiguration) { mocked.options = options; }
  },
}));
vi.mock("@/components/board-text/styles.module.css", () => ({ default: { content: "content" } }));
vi.mock("katex/dist/katex.min.css", () => ({}));

const session: BoardSession = { role: "editor", user: { id: "student", name: "Ученик" },
  connection: { url: "ws://localhost/collaboration", token: "cookie" },
  board: { id: "board", role: "editor", ownerId: "teacher", title: "Доска", authorName: "Teacher", imageUrl: "",
    createdAt: 0, updatedAt: 0, isFavorite: false } };
const runtimes: BoardRuntime[] = [];
function runtime() {
  const result = new BoardRuntime(session); runtimes.push(result);
  result.board.doc.getMap("meta").set("schemaVersion", 2);
  mocked.options!.onStatus?.({ status: WebSocketStatus.Connected });
  mocked.options!.onSynced?.({ state: true });
  return result;
}
function role(value: BoardRole) { mocked.options!.onStateless?.({ payload: JSON.stringify({ type: "access-role", role: value }) }); }
function Controls() {
  const current = useBoardRuntime();
  const effectiveRole = useBoardRole();
  useConnectionState();
  return <><SaveStatus /><output data-testid="effective-role">{effectiveRole ?? "unknown"}</output>
    {current.board.canEdit && <button>Редактировать</button>}</>;
}
afterEach(() => { cleanup(); runtimes.splice(0).forEach((value) => value.destroy()); });

describe("live board role UI", () => {
  it("waits for server authority and updates viewer status and controls without reload", () => {
    const current = runtime();
    render(<BoardRuntimeContext.Provider value={current}><Controls /></BoardRuntimeContext.Provider>);
    expect(screen.getByTestId("effective-role").textContent).toBe("unknown");
    expect(screen.queryByRole("button", { name: "Редактировать" })).toBeNull();
    act(() => role("viewer"));
    expect(screen.getByText("Только просмотр")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Редактировать" })).toBeNull();
    act(() => role("editor"));
    expect(screen.queryByText("Только просмотр")).toBeNull();
    expect(screen.getByRole("button", { name: "Редактировать" })).toBeTruthy();
    act(() => role("viewer"));
    expect(screen.getByText("Только просмотр")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Редактировать" })).toBeNull();
    expect(current.session).toBe(session);
  });

  it("deactivates an active text editor on demotion and promotion does not restore old editing", async () => {
    const current = runtime(); role("editor");
    const [id] = current.board.insert([createLayer(LayerType.Text, { x: 0, y: 0 }, { r: 0, g: 0, b: 0 })]);
    render(<BoardRuntimeContext.Provider value={current}><BoardTextProvider><Controls />
      <RichTextContent id={id} minHeight={30} onHeight={() => {}} />
    </BoardTextProvider></BoardRuntimeContext.Provider>);
    const block = document.querySelector(`[data-board-text-id="${id}"]`)!;
    fireEvent.doubleClick(block);
    await waitFor(() => expect(screen.getByRole("textbox", { name: "Текст на доске" })).toBeTruthy());
    act(() => role("viewer"));
    await waitFor(() => expect(screen.queryByRole("textbox", { name: "Текст на доске" })).toBeNull());
    expect(screen.getByText("Только просмотр")).toBeTruthy();
    act(() => role("editor"));
    expect(screen.getByRole("button", { name: "Редактировать" })).toBeTruthy();
    expect(screen.queryByRole("textbox", { name: "Текст на доске" })).toBeNull();
  });
});
