import { useEffect } from "react";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Editor } from "@tiptap/core";
import { BoardRuntimeContext } from "@/lib/collaboration/react";
import { BoardDocument } from "@/lib/collaboration/document";
import type { BoardRuntime, ConnectionState } from "@/lib/collaboration/runtime";
import { emptyPresence } from "@/lib/collaboration/presence";
import { createLayer } from "@/lib/board/model";
import { LayerType } from "@/types/board-canvas";
import { BoardTextProvider, useBoardText } from "@/components/board-text/provider";
import { RichTextContent } from "@/components/board-text/content";
import { RichTextToolbar } from "@/components/board-text/toolbar";

vi.mock("@/components/board-text/styles.module.css", () => ({ default: { content: "content" } }));
vi.mock("katex/dist/katex.min.css", () => ({}));

afterEach(cleanup);

describe("active rich-text editor lifecycle", () => {
  it("does not reassert local measured height on persistence acknowledgements", async () => {
    const board = new BoardDocument();
    const [id] = board.insert([createLayer(LayerType.Text, { x: 0, y: 0 }, { r: 0, g: 0, b: 0 })]);
    const self = { presence: { ...emptyPresence(), selection: [id] } };
    let state: ConnectionState = { connected: true, synced: true, saved: true, error: null, revision: 0, savedAt: null, pending: false, writeRejection: null };
    const stateListeners = new Set<() => void>();
    const runtime = { board, getSelf: () => self, getState: () => state,
      subscribeState: (listener: () => void) => { stateListeners.add(listener); return () => stateListeners.delete(listener); },
      subscribePresence: () => () => {}, updatePresence: () => {},
    } as unknown as BoardRuntime;
    const result = render(<BoardRuntimeContext.Provider value={runtime}><BoardTextProvider>
      <RichTextContent id={id} minHeight={30} onHeight={() => {}} />
    </BoardTextProvider></BoardRuntimeContext.Provider>);
    await waitFor(() => expect(board.getLayer(id)?.height).toBe(30));
    act(() => { board.doc.transact(() => board.layers.get(id)!.set("height", 120), "peer"); });
    for (let revision = 1; revision <= 5; revision += 1) {
      act(() => { state = { ...state, revision }; stateListeners.forEach((listener) => listener()); });
    }
    expect(board.getLayer(id)?.height).toBe(120);
    result.unmount();
    board.destroy();
  });

  it("mounts on double-click, leaves editing outside and keeps text undo after unmount", async () => {
    const board = new BoardDocument();
    const [id] = board.insert([createLayer(LayerType.Text, { x: 0, y: 0 }, { r: 0, g: 0, b: 0 })]);
    const listeners = new Set<() => void>();
    let self = { presence: { ...emptyPresence(), selection: [id] } };
    const state: ConnectionState = { connected: true, synced: true, saved: true, error: null, revision: 0, savedAt: null, pending: false, writeRejection: null };
    const runtime = { board, getSelf: () => self, getState: () => state,
      subscribeState: () => () => {}, subscribePresence: (listener: () => void) => { listeners.add(listener); return () => listeners.delete(listener); },
      updatePresence: (patch: Partial<typeof self.presence>) => { self = { presence: { ...self.presence, ...patch } }; listeners.forEach((listener) => listener()); },
    } as unknown as BoardRuntime;
    const probe: { editor: Editor | null } = { editor: null };
    function Probe() {
      const { editor } = useBoardText();
      useEffect(() => { probe.editor = editor; }, [editor]);
      return null;
    }
    const result = render(<BoardRuntimeContext.Provider value={runtime}><BoardTextProvider>
      <Probe /><RichTextContent id={id} minHeight={30} onHeight={() => {}} />
      <div data-board-text-toolbar><RichTextToolbar id={id} /></div>
      <button aria-label="outside" onPointerDown={(event) => event.preventDefault()}>Outside</button>
    </BoardTextProvider></BoardRuntimeContext.Provider>);
    const content = result.container.querySelector('[data-placeholder="Текст"]')!;
    fireEvent.doubleClick(content);
    await result.findByRole("textbox", { name: "Текст на доске" });
    await waitFor(() => expect(probe.editor).not.toBeNull());
    act(() => { probe.editor!.commands.insertContent({ type: "text", text: "Совместный текст" }); });
    expect(JSON.stringify(board.getRichText(id))).toContain("Совместный текст");
    fireEvent.pointerDown(result.getByLabelText("outside"));
    await waitFor(() => expect(result.queryByRole("textbox", { name: "Текст на доске" })).toBeNull());
    act(() => board.undo());
    expect(JSON.stringify(board.getRichText(id))).not.toContain("Совместный текст");
    act(() => board.redo());
    fireEvent.doubleClick(content);
    await result.findByRole("textbox", { name: "Текст на доске" });
    await waitFor(() => expect(probe.editor?.getText()).toContain("Совместный текст"));
    result.unmount();
    board.destroy();
  });
});
