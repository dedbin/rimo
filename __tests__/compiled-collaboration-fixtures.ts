import { fork } from "node:child_process";
import { createServer } from "node:net";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { HocuspocusProvider, HocuspocusProviderWebsocket } from "@hocuspocus/provider";
import WebSocket from "ws";
import * as Y from "yjs";

import { ORIGIN, waitFor } from "../collaboration-server/__tests__/helpers";
import { parseServerMessage } from "../lib/collaboration/protocol";
import type { PersistedMessage } from "../lib/collaboration/protocol";

export async function freeCompiledPort(): Promise<number> {
  const socket = createServer();
  await new Promise<void>((resolve, reject) => {
    socket.once("error", reject);
    socket.listen(0, "127.0.0.1", resolve);
  });
  const address = socket.address();
  await new Promise<void>((resolve, reject) => socket.close(error => error ? reject(error) : resolve()));
  if (!address || typeof address === "string") throw new Error("No compiled test port");
  return address.port;
}

export function startCompiledRuntime(entry: string, databaseUrl: string, port: number, secret: string) {
  const child = fork(entry, [], {
    execArgv: ["--enable-source-maps", "--import", pathToFileURL(path.resolve("__tests__/fixtures/collaboration-process.mjs")).href],
    env: { ...process.env, NODE_OPTIONS: "", NODE_ENV: "production", DATABASE_URL: databaseUrl,
      BETTER_AUTH_SECRET: secret, BETTER_AUTH_URL: ORIGIN, TRUSTED_ORIGINS: "",
      COLLABORATION_PUBLIC_URL: `ws://127.0.0.1:${port}`, COLLABORATION_PORT: String(port), COLLABORATION_HOST: "127.0.0.1" },
    windowsHide: true, stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  let output = "";
  let overflow = false;
  let spawnFailed = false;
  let identity: unknown;
  const append = (chunk: Buffer): void => {
    if (output.length + chunk.length > 65_536) { overflow = true; return; }
    output += chunk.toString();
  };
  child.stdout?.on("data", append);
  child.stderr?.on("data", append);
  child.on("error", () => { spawnFailed = true; });
  child.on("message", (message) => { identity = message; });
  const exited = new Promise<{ code: number | null; signal: string | null }>(resolve => {
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  const isExited = (): boolean => child.exitCode !== null || child.signalCode !== null;
  return {
    async ready(): Promise<unknown> {
      await waitFor(() => output.includes('"event":"collaboration_started"') || isExited() || spawnFailed || overflow, 10_000);
      if (isExited() || spawnFailed || overflow) throw new Error("Compiled runtime did not start cleanly");
      child.send({ type: "probe" });
      await waitFor(() => identity !== undefined || isExited(), 2_000);
      if (isExited()) throw new Error("Compiled runtime exited during module identity check");
      return identity;
    },
    async stop(): Promise<void> {
      let timer: ReturnType<typeof setTimeout> | undefined;
      let forced = false;
      try {
        if (!isExited() && child.connected) child.send({ type: "stop" }, () => undefined);
        timer = setTimeout(() => { forced = true; child.kill("SIGKILL"); }, 17_000);
        const result = await exited;
        if (forced || result.code !== 0 || result.signal !== null || overflow) {
          throw new Error("Compiled runtime did not exit gracefully");
        }
      } finally { clearTimeout(timer); }
    },
  };
}

export function compiledClient(port: number, boardId: string, cookie: string) {
  const document = new Y.Doc();
  const acknowledgements: PersistedMessage[] = [];
  let closed = false;
  let failed = false;
  let destroyed = false;
  const websocket = new HocuspocusProviderWebsocket({
    url: `ws://127.0.0.1:${port}`, autoConnect: false, maxAttempts: 1, jitter: false, initialDelay: 0,
    WebSocketPolyfill: class extends WebSocket {
      constructor(address: string) { super(address, { headers: { Origin: ORIGIN, Cookie: cookie } }); }
    },
  });
  const provider = new HocuspocusProvider({
    name: boardId, document, token: "cookie", websocketProvider: websocket,
    onStateless({ payload }) {
      const message = parseServerMessage(payload);
      if (message?.type === "persisted") acknowledgements.push(message);
      if (message?.type === "persistence-error") failed = true;
    },
    onAuthenticationFailed() { failed = true; websocket.disconnect(); },
    onClose() { closed = true; websocket.disconnect(); },
  });
  provider.attach();
  return {
    document, acknowledgements,
    async connect(): Promise<void> {
      if (!cookie) throw new Error("No authentication cookie");
      void websocket.connect().catch(() => { failed = true; });
      await waitFor(() => provider.isSynced || closed || failed, 6_000);
      if (closed || failed) throw new Error("Compiled runtime rejected the test handshake");
      provider.sendStateless('{"type":"persistence-status"}');
      await waitFor(() => this.isSaved() || closed || failed);
      if (closed || failed) throw new Error("Compiled runtime did not acknowledge the initial state");
    },
    isSaved(): boolean {
      const acknowledgement = acknowledgements.at(-1);
      return !!acknowledgement && Y.equalSnapshots(Y.snapshot(document), Y.decodeSnapshot(Buffer.from(acknowledgement.snapshot, "base64")));
    },
    isClosed: (): boolean => closed,
    destroy(): void {
      if (destroyed) return;
      destroyed = true;
      provider.destroy(); websocket.destroy(); document.destroy();
    },
  };
}
