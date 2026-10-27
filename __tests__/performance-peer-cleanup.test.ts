// @vitest-environment node
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

const execute = promisify(execFile);
// Keep the real ws error event in a child: an unhandled error must fail this regression.
const source = `
  import { createServer } from "node:http";
  import { createRequire } from "node:module";
  import { setImmediate as nextTurn } from "node:timers/promises";
  import { openProvider, safeError, waitFor, writeFinalReport } from "./scripts/performance/common.mjs";
  const { createCollaborationServer } = createRequire(import.meta.url)("./collaboration-server/server.ts");
  const [scenario, filename] = process.argv.slice(1);
  const controller = new AbortController();
  const sockets = new Set();
  let stalled;
  const upgrade = new Promise((resolve) => { stalled = resolve; });
  const handshake = createServer();
  handshake.on("connection", (socket) => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); });
  handshake.on("upgrade", (_request, socket) => {
    stalled();
    if (scenario === "abort") controller.abort();
    if (scenario === "transport-error") socket.end("HTTP/1.1 503 Unavailable\\r\\nConnection: close\\r\\nContent-Length: 0\\r\\n\\r\\n");
  });
  await new Promise((resolve) => handshake.listen(0, "127.0.0.1", resolve));
  const stalledUrl = "ws://127.0.0.1:" + handshake.address().port;
  const boardId = "00000000-0000-4000-8000-000000000001";
  const baseURL = "http://127.0.0.1:3000";
  const context = (url) => ({
    async fetch() { return { ok: () => true, status: () => 200,
      json: async () => ({ user: { id: "fixture" }, role: "editor", connection: { url, token: "cookie" } }) }; },
    async storageState() { return { cookies: [] }; },
  });
  const report = { status: "failed", result: null, cleanup: [], closeErrors: [] };
  let server;
  let peer;
  try {
    if (scenario === "already-failed") {
      let snapshot;
      server = createCollaborationServer({ origins: [baseURL], port: 0 }, {
        repository: {
          async load() { return snapshot ?? null; },
          async save(_id, state) { snapshot = { state: new Uint8Array(state), revision: (snapshot?.revision ?? 0) + 1, savedAt: new Date() }; return snapshot; },
          async health() { return true; },
        },
        async authenticate(_headers, boardId) { return { boardId, userId: "fixture", sessionId: "fixture", name: "Fixture", role: "editor" }; },
        async revalidate(principal) { return principal.role; },
      });
      await server.listen();
      peer = await openProvider(context("ws://127.0.0.1:" + server.address.port), baseURL, boardId);
      server.hocuspocus.documents.get(boardId).getConnections()[0].close({ code: 1008, reason: "Connection receive limit reached" });
      await waitFor(() => peer.failure !== null);
      peer.websocket.configuration.url = stalledUrl;
      void peer.websocket.createWebSocketConnection().catch(() => undefined);
      await upgrade;
      await peer.close();
      report.result = { error: peer.failure, closeEvent: peer.closeEvent };
    } else {
      try { peer = await openProvider(context(stalledUrl), baseURL, boardId, controller.signal); }
      catch (error) { report.result = { error: safeError(error) }; }
    }
    await nextTurn();
    await writeFinalReport(filename, report, controller.signal);
    process.stdout.write(JSON.stringify({ finalReportWritten: true }) + "\\n");
  } finally {
    await peer?.close();
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => handshake.close(resolve));
    await server?.destroy();
  }
`;

describe("performance peer WebSocket error lifecycle", () => {
  it.each(["abort", "already-failed", "transport-error"])("writes the final report after %s during a real WebSocket handshake", async (scenario) => {
    const filename = path.resolve(`temp/performance/peer-cleanup-${randomUUID()}.json`);
    try {
      const result = await execute(process.execPath, ["--import=tsx", "--input-type=module", "--eval", source, scenario, filename],
        { timeout: 12_000, windowsHide: true }).then((output) => ({ code: 0, ...output }),
        (error: { code: number; stdout: string; stderr: string }) => error);
      expect(result.stderr).toBe("");
      expect(result.code).toBe(scenario === "abort" ? 1 : 0);
      expect(result.stdout).toContain('"finalReportWritten":true');
      const report = JSON.parse(await readFile(filename, "utf8"));
      expect(report.cleanup).toEqual([]);
      expect(report.closeErrors).toEqual([]);
      expect(report.status).toBe(scenario === "abort" ? "interrupted" : "failed");
      if (scenario === "abort") expect(report.result.error).toBe("Operation interrupted");
      else if (scenario === "already-failed") expect(report.result).toEqual({
        error: "Connection closed (1000/receive-limit)", closeEvent: { code: 1000, reason: "receive-limit" },
      });
      else expect(report.result.error).toBe("WebSocket connection failed");
    } finally { await rm(filename, { force: true }); }
  }, 15_000);
});
