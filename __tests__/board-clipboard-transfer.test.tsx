import { act, cleanup, fireEvent, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PropsWithChildren } from "react";
import { toast } from "sonner";
import { useCanvasClipboard } from "@/app/board/[boardId]/_hooks/use-canvas-clipboard";
import { BoardRuntimeContext } from "@/lib/collaboration/react";
import type { BoardRuntime } from "@/lib/collaboration/runtime";
import { BoardDocument } from "@/lib/collaboration/document";
import { emptyPresence } from "@/lib/collaboration/presence";
import { copyBoardImageAssets } from "@/lib/board/assets-client";
import { BOARD_CLIPBOARD_MIME, BoardClipboard, serializeLayers } from "@/lib/board/clipboard";
import { insertBoardClipboard } from "@/lib/board/clipboard-transfer";
import { createLayer } from "@/lib/board/model";
import type { RichTextDocument } from "@/lib/board/rich-text/types";
import { LayerType } from "@/types/board-canvas";

const SOURCE = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const COPIED = "33333333-3333-4333-8333-333333333333";
const destination = "44444444-4444-4444-8444-444444444444";
const color = { r: 0, g: 0, b: 0 };
const rich: RichTextDocument = { type: "doc", content: [{ type: "paragraph", content: [
  { type: "text", text: "Условие", marks: [{ type: "bold" }] },
  { type: "inlineMath", attrs: { latex: "x^2" } },
] }] };
const asset = (id = COPIED) => ({ id, url: `/api/assets/${id}`, mimeType: "image/webp", width: 200, height: 100, size: 128 });
const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
const boards: BoardDocument[] = [];
function board() { const value = new BoardDocument(); boards.push(value); return value; }
function clipboard(): BoardClipboard {
  return { layers: [
    { type: LayerType.Image, x: 10, y: 20, width: 200, height: 100, src: `/api/assets/${SOURCE}` },
    createLayer(LayerType.Text, { x: 40, y: 30 }, color),
    { type: LayerType.Image, x: 80, y: 50, width: 100, height: 50, src: `/api/assets/${SOURCE}` },
  ], richText: [null, rich, null] };
}
function delayedResponse() {
  let finish!: (response: Response) => void;
  const fetchMock = vi.fn<typeof fetch>(() => new Promise<Response>((resolve) => { finish = resolve; }));
  vi.stubGlobal("fetch", fetchMock);
  return { fetchMock, finish: (value: Response) => finish(value) };
}
function mountClipboard(target: BoardDocument) {
  const updatePresence = vi.fn();
  const listeners = new Set<() => void>();
  const runtime = { board: target, session: { board: { id: destination } }, updatePresence,
    subscribeState: (listener: () => void) => { listeners.add(listener); return () => listeners.delete(listener); },
    getSelf: () => ({ presence: emptyPresence() }),
  } as unknown as BoardRuntime;
  const wrapper = ({ children }: PropsWithChildren) => <BoardRuntimeContext.Provider value={runtime}>{children}</BoardRuntimeContext.Provider>;
  return { ...renderHook(() => useCanvasClipboard({ color, cancel: () => {}, setCanvasState: () => {} }), { wrapper }), updatePresence,
    notifyState: () => listeners.forEach((listener) => listener()), listeners };
}
function pasteFiles(files: File[]) {
  const event = new Event("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "clipboardData", { value: { getData: () => "", items: files.map((file) => ({ type: file.type, getAsFile: () => file })) } });
  fireEvent(window, event);
}
const imageFile = () => new File(["png"], "fixture.png", { type: "image/png" });
afterEach(() => { cleanup(); boards.forEach((value) => value.destroy()); boards.length = 0; vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("clipboard asset transfer", () => {
  it("deduplicates images, transfers them before a single insertion, preserves rich text and undoes the whole paste", async () => {
    const target = board();
    const updates = vi.fn(); target.doc.on("update", updates);
    const input = clipboard(); const original = structuredClone(input);
    const request = delayedResponse();
    const operation = insertBoardClipboard(destination, target, input);
    expect(target.getSnapshot().layerIds).toHaveLength(0);
    expect(request.fetchMock).toHaveBeenCalledOnce();
    expect(request.fetchMock.mock.calls[0]).toMatchObject([`/api/boards/${destination}/assets/copy`, {
      method: "POST", body: JSON.stringify({ assetIds: [SOURCE] }),
    }]);
    request.finish(response({ assets: { [SOURCE]: asset() } }));
    const ids = await operation;
    expect(ids).toHaveLength(3);
    expect(updates).toHaveBeenCalledOnce();
    expect(target.getLayer(ids[0])).toMatchObject({ src: `/api/assets/${COPIED}`, x: 10, y: 20 });
    expect(target.getLayer(ids[2])).toMatchObject({ src: `/api/assets/${COPIED}`, width: 100, height: 50 });
    expect(target.getRichText(ids[1])).toEqual(rich);
    expect(input).toEqual(original);
    target.undo();
    expect(target.getSnapshot().layerIds).toHaveLength(0);
    target.redo();
    expect(target.getRichText(ids[1])).toEqual(rich);
  });

  it("makes no layer changes when source access or destination quota rejects the transfer", async () => {
    const target = board(); const updates = vi.fn(); target.doc.on("update", updates);
    vi.stubGlobal("fetch", vi.fn(async () => response({ error: { code: "QUOTA_EXCEEDED", message: "Недостаточно места на доске" } }, 413)));
    await expect(insertBoardClipboard(destination, target, clipboard())).rejects.toThrow("Недостаточно места");
    expect(target.getSnapshot().layerIds).toHaveLength(0);
    expect(updates).not.toHaveBeenCalled();
  });

  it.each([
    { assets: {} },
    { assets: { [SOURCE]: { ...asset(), url: "https://example.test/image.webp" } } },
    { assets: { [SOURCE]: asset(), [OTHER]: asset() } },
    { assets: { [SOURCE]: { ...asset(), width: 0 } } },
  ])("rejects incomplete or invalid asset responses without inserting a partial paste", async (result) => {
    const target = board();
    vi.stubGlobal("fetch", vi.fn(async () => response(result)));
    await expect(insertBoardClipboard(destination, target, clipboard())).rejects.toThrow("Вставка отменена");
    expect(target.getSnapshot().layerIds).toHaveLength(0);
  });

  it("rechecks edit permission after the transfer and ignores an aborted operation", async () => {
    const target = board();
    const denied = delayedResponse();
    const operation = insertBoardClipboard(destination, target, clipboard());
    target.setWritable(false);
    denied.finish(response({ assets: { [SOURCE]: asset() } }));
    await expect(operation).rejects.toThrow("Право редактирования изменилось");
    expect(target.getSnapshot().layerIds).toHaveLength(0);
    target.setWritable(true);
    const request = delayedResponse();
    const controller = new AbortController();
    const cancelled = insertBoardClipboard(destination, target, clipboard(), controller.signal);
    controller.abort();
    request.finish(response({ assets: { [SOURCE]: asset() } }));
    expect(await cancelled).toEqual([]);
    expect(target.getSnapshot().layerIds).toHaveLength(0);
  });

  it("keeps text-only paste local and refuses invalid or excessive image IDs before sending a request", async () => {
    const target = board(); const fetchMock = vi.fn(); vi.stubGlobal("fetch", fetchMock);
    const input = clipboard();
    const ids = await insertBoardClipboard(destination, target, { layers: [input.layers[1]], richText: [rich] });
    expect(target.getRichText(ids[0])).toEqual(rich);
    expect(fetchMock).not.toHaveBeenCalled();
    await expect(copyBoardImageAssets(destination, ["not-an-asset"])).rejects.toThrow();
    const many = Array.from({ length: 101 }, (_, index) => `11111111-1111-4111-8111-${String(index).padStart(12, "0")}`);
    await expect(copyBoardImageAssets(destination, many)).rejects.toThrow("до 100");
    target.setWritable(false);
    expect(await insertBoardClipboard(destination, target, clipboard())).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("aborts pending paste on canvas unmount and cannot insert after a late response", async () => {
    const target = board(); const request = delayedResponse();
    const result = mountClipboard(target);
    const payload = clipboard();
    const event = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "clipboardData", { value: { getData: (type: string) => type === BOARD_CLIPBOARD_MIME
      ? serializeLayers(payload.layers, payload.richText) : "" } });
    act(() => { fireEvent(window, event); });
    expect(request.fetchMock).toHaveBeenCalledOnce();
    const signal = request.fetchMock.mock.calls[0][1]?.signal;
    result.unmount();
    expect(signal?.aborted).toBe(true);
    await act(async () => { request.finish(response({ assets: { [SOURCE]: asset() } })); });
    expect(target.getSnapshot().layerIds).toHaveLength(0);
    expect(result.updatePresence).not.toHaveBeenCalled();
  });

  it("aborts an in-flight paste on demotion and promotion before its late response cannot revive it", async () => {
    const target = board(); const request = delayedResponse();
    const hook = mountClipboard(target);
    const payload = clipboard();
    const event = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "clipboardData", { value: { getData: (type: string) => type === BOARD_CLIPBOARD_MIME
      ? serializeLayers(payload.layers, payload.richText) : "" } });
    act(() => fireEvent(window, event));
    const signal = request.fetchMock.mock.calls[0][1]?.signal;
    expect(signal?.aborted).toBe(false);
    act(() => { target.setWritable(false); hook.notifyState(); });
    expect(signal?.aborted).toBe(true);
    act(() => { target.setWritable(true); hook.notifyState(); });
    await act(async () => { request.finish(response({ assets: { [SOURCE]: asset() } })); });
    expect(target.getSnapshot().layerIds).toHaveLength(0);
    expect(hook.updatePresence).not.toHaveBeenCalled();
    hook.unmount();
    expect(hook.listeners.size).toBe(0);
  });
});

describe("clipboard image-file batches", () => {
  it("uploads more than two images sequentially and inserts the complete batch in one undoable transaction", async () => {
    const target = board(); const updates = vi.fn(); target.doc.on("update", updates);
    let active = 0; let peak = 0; let next = 0;
    const fetchMock = vi.fn<typeof fetch>(async () => {
      active += 1; peak = Math.max(peak, active);
      const rejected = active > 2;
      await Promise.resolve();
      active -= 1;
      return rejected ? response({ error: { message: "Слишком много загрузок" } }, 429)
        : response({ asset: asset(`11111111-1111-4111-8111-${String(++next).padStart(12, "0")}`) });
    });
    vi.stubGlobal("fetch", fetchMock); mountClipboard(target);
    act(() => pasteFiles([imageFile(), imageFile(), imageFile()]));
    await waitFor(() => expect(target.getSnapshot().layerIds).toHaveLength(3));
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(peak).toBe(1);
    expect(updates).toHaveBeenCalledOnce();
    target.undo(); expect(target.getSnapshot().layerIds).toHaveLength(0);
  });

  it.each(["unsupported", "oversized", "too-many"])("validates the entire %s batch before its first upload", async (kind) => {
    const target = board(); const fetchMock = vi.fn(); vi.stubGlobal("fetch", fetchMock);
    const error = vi.spyOn(toast, "error").mockImplementation(() => "toast"); mountClipboard(target);
    const invalid = new File([kind === "oversized" ? new Uint8Array(10 * 1024 * 1024 + 1) : "svg"], "invalid", {
      type: kind === "unsupported" ? "image/svg+xml" : "image/png",
    });
    const files = kind === "too-many" ? Array.from({ length: 101 }, imageFile) : [imageFile(), imageFile(), invalid];
    await act(async () => pasteFiles(files));
    expect(error).toHaveBeenCalledOnce(); expect(fetchMock).not.toHaveBeenCalled();
    expect(target.getSnapshot().layerIds).toHaveLength(0);
  });

  it("aborts the batch on upload failure without starting the next file or inserting earlier files", async () => {
    const target = board(); const error = vi.spyOn(toast, "error").mockImplementation(() => "toast");
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(response({ asset: asset() }))
      .mockResolvedValueOnce(response({ error: { message: "Недостаточно места" } }, 413));
    vi.stubGlobal("fetch", fetchMock); mountClipboard(target);
    act(() => pasteFiles([imageFile(), imageFile(), imageFile()]));
    await waitFor(() => expect(error).toHaveBeenCalledWith("Недостаточно места"));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0][1]?.signal?.aborted).toBe(true);
    expect(target.getSnapshot().layerIds).toHaveLength(0);
  });

  it("aborts a file batch on unmount before a late upload can start further requests", async () => {
    const target = board(); const request = delayedResponse(); const result = mountClipboard(target);
    act(() => pasteFiles([imageFile(), imageFile(), imageFile()]));
    expect(request.fetchMock).toHaveBeenCalledOnce();
    result.unmount();
    expect(request.fetchMock.mock.calls[0][1]?.signal?.aborted).toBe(true);
    await act(async () => request.finish(response({ asset: asset() })));
    expect(request.fetchMock).toHaveBeenCalledOnce();
    expect(target.getSnapshot().layerIds).toHaveLength(0);
    expect(result.updatePresence).not.toHaveBeenCalled();
  });
});
