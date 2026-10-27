// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { HocuspocusProviderWebsocket, WebSocketStatus } from "@hocuspocus/provider";
import * as Y from "yjs";

import { BoardRuntime } from "@/lib/collaboration/runtime";
import { createLayer } from "@/lib/board/model";
import { LayerType } from "@/types/board-canvas";
import type { BoardSession } from "@/types/service";

const session: BoardSession = { role: "owner", user: { id: "owner", name: "Владелец" },
  connection: { url: "ws://localhost/collaboration", token: "cookie" },
  board: { id: "board", role: "owner", ownerId: "owner", title: "Доска", authorName: "Владелец", imageUrl: "",
    createdAt: 0, updatedAt: 0, isFavorite: false } };

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

describe("quota rejection with the installed Hocuspocus SDK", () => {
  it.each(["Board storage limit reached", "Board object limit reached"])("uses public disconnect to stop transport retries while preserving Y.Doc: %s", async (reason) => {
    vi.useFakeTimers();
    // Suppress only network creation; the SDK provider, disconnect, close, and retry logic remain real.
    const connect = vi.spyOn(HocuspocusProviderWebsocket.prototype, "connect").mockResolvedValue(undefined);
    const runtime = new BoardRuntime(session);
    const transport = runtime.provider.configuration.websocketProvider;
    const socket = { identifier: 1, readyState: 3, close: vi.fn(), send: vi.fn(),
      addEventListener: vi.fn(), removeEventListener: vi.fn() } as unknown as NonNullable<typeof transport.webSocket>;
    transport.webSocket = socket;
    transport.attachWebSocketListeners(socket, vi.fn());
    try {
      runtime.board.doc.getMap("meta").set("schemaVersion", 2);
      runtime.provider.configuration.onStatus({ status: WebSocketStatus.Connected });
      runtime.provider.configuration.onStateless({ payload: JSON.stringify({ type: "access-role", role: "owner" }) });
      runtime.provider.configuration.onSynced({ state: true });
      runtime.board.insert([createLayer(LayerType.Rectangle, { x: 10, y: 20 }, { r: 0, g: 0, b: 0 })]);
      const doc = runtime.board.doc; const draft = Y.encodeStateAsUpdate(doc);
      const disconnect = vi.spyOn(runtime.provider, "disconnect");
      runtime.provider.configuration.onClose({ event: { code: 1000, reason } });
      expect(disconnect).toHaveBeenCalledTimes(1);
      expect(socket.close).toHaveBeenCalledTimes(1);
      expect(transport.shouldConnect).toBe(false);
      connect.mockClear();
      transport.onClose({ event: { code: 1000, reason: "" } });
      await vi.advanceTimersByTimeAsync(10_000);
      expect(connect).not.toHaveBeenCalled();
      expect(socket.send).not.toHaveBeenCalled();
      expect(runtime.getState()).toMatchObject({ saved: false, pending: true });
      expect(doc.isDestroyed).toBe(false); expect(runtime.board.doc).toBe(doc);
      expect(Y.encodeStateAsUpdate(doc)).toEqual(draft);
    } finally { runtime.destroy(); }
  });
});
