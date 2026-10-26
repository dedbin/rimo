import { Buffer } from "node:buffer";

import { HocuspocusProvider, HocuspocusProviderWebsocket } from "@hocuspocus/provider";
import WebSocket from "ws";
import * as Y from "yjs";

import { parseServerMessage } from "../../lib/collaboration/protocol";
import type { PersistedMessage, ServerMessage } from "../../lib/collaboration/protocol";

export const ORIGIN = "http://localhost:3000";
export const BOARD_ID = "bb9060d1-f1ae-4655-9752-dc64f5d52397";

export async function waitFor(predicate: () => boolean, timeout = 5_000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for collaboration state");
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
}

export function createTestClient(url: string, user: string, boardId = BOARD_ID) {
  const document = new Y.Doc();
  const messages: ServerMessage[] = [];
  const websocketProvider = new HocuspocusProviderWebsocket({
    url,
    autoConnect: false,
    maxAttempts: 1,
    jitter: false,
    initialDelay: 0,
    WebSocketPolyfill: class extends WebSocket {
      constructor(address: string) {
        super(address, { headers: { Origin: ORIGIN, Cookie: `rimo-test=${user}` } });
      }
    },
  });
  const provider = new HocuspocusProvider({
    name: boardId,
    document,
    token: "cookie",
    websocketProvider,
    onStateless({ payload }) {
      const message = parseServerMessage(payload);
      if (message) messages.push(message);
    },
  });
  provider.attach();
  return {
    document, provider, websocketProvider, messages,
    async connect() {
      await websocketProvider.connect();
      await waitFor(() => provider.isSynced);
      provider.sendStateless(JSON.stringify({ type: "persistence-status" }));
    },
    lastAcknowledgement(): PersistedMessage | undefined {
      return messages.filter((message): message is PersistedMessage => message.type === "persisted").at(-1);
    },
    isPersisted(): boolean {
      const acknowledgement = this.lastAcknowledgement();
      return !!acknowledgement && Y.equalSnapshots(
        Y.snapshot(document),
        Y.decodeSnapshot(Buffer.from(acknowledgement.snapshot, "base64")),
      );
    },
    destroy() {
      provider.destroy();
      websocketProvider.destroy();
      document.destroy();
    },
  };
}

export type TestClient = ReturnType<typeof createTestClient>;

export function insertRectangle(document: Y.Doc, id: string, x = 0): void {
  document.transact(() => {
    document.getMap<Y.Map<unknown>>("layers").set(id, new Y.Map<unknown>([
      ["type", 0], ["x", x], ["y", 0], ["width", 100], ["height", 100],
      ["fill", { r: 0, g: 0, b: 0 }],
    ]));
    document.getArray<string>("layerIds").push([id]);
  });
}
