import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { createCollaborationServer } from "../../collaboration-server/server.ts";

import { installLoadInterruptHandlers, openProvider, waitFor } from "./common.mjs";
import { idAt, seedScene } from "./fixture.mjs";
import { runLoad } from "./load-runner.mjs";

const baseURL = "http://127.0.0.1:3000";
const boardId = randomUUID();
let snapshot;
const server = createCollaborationServer({ origins: [baseURL], port: 0,
  limits: { persistenceDebounceMs: 20, persistenceMaxDebounceMs: 50 } }, {
  repository: {
    async load() { return snapshot ?? null; },
    async save(_boardId, state) {
      snapshot = { state: new Uint8Array(state), revision: (snapshot?.revision ?? 0) + 1, savedAt: new Date() };
      return snapshot;
    },
    async health() { return true; },
  },
  async authenticate(headers, requestedBoard) {
    if (requestedBoard !== boardId) return null;
    const viewer = headers.get("cookie")?.includes("fixture-role=viewer");
    return { boardId, userId: viewer ? "viewer" : "editor", sessionId: viewer ? "viewer" : "editor",
      name: "Harness self-check", role: viewer ? "viewer" : "editor" };
  },
  async revalidate(principal) { return principal.role; },
});

function context(role) {
  const session = { board: { id: boardId }, role, user: { id: role, name: role },
    connection: { url: `ws://127.0.0.1:${server.address.port}`, token: "cookie" } };
  return {
    async fetch() { return { ok: () => true, status: () => 200, json: async () => session }; },
    async storageState() { return { cookies: [{ domain: "127.0.0.1", path: "/", expires: -1,
      httpOnly: true, secure: false, sameSite: "Lax", name: "fixture-role", value: role }] }; },
  };
}

const clients = [];
const interruptSignal = process.argv[2];
if (interruptSignal && !["SIGINT", "SIGTERM"].includes(interruptSignal)) throw new Error("Expected SIGINT or SIGTERM");
const controller = new AbortController();
const removeInterruptHandlers = installLoadInterruptHandlers(controller);
let interruptDelivered = false;
try {
  await server.listen();
  const writer = await openProvider(context("editor"), baseURL, boardId);
  clients.push(writer);
  seedScene(writer.document, 100, `/api/assets/${randomUUID()}`);
  await waitFor(() => writer.isPersisted());
  const viewer = await openProvider(context("viewer"), baseURL, boardId);
  clients.push(viewer);
  assert.equal(viewer.provider.authorizedScope, "readonly");
  const unchanged = viewer.document.getMap("layers").get(idAt(99)).get("x");
  const batchBefore = viewer.document.getMap("layers").get(idAt(49)).get("x");
  const editHz = interruptSignal ? 1 : 4;
  const result = await runLoad([{ boardId, clients, writers: [writer] }], {
    seconds: interruptSignal ? 30 : 2, objects: 100, editHz, presenceHz: 10, batchSize: 50,
    batchEverySeconds: 1, sampleSeconds: 1,
  }, controller.signal, ({ elapsedSeconds }) => {
    if (interruptSignal && elapsedSeconds >= 1 && !interruptDelivered) { interruptDelivered = true; process.emit(interruptSignal); }
  });
  assert.equal(result.error, null);
  assert(result.sentChanges >= (interruptSignal ? 1 : 6));
  assert.equal(result.propagationMs.count, result.sentChanges);
  assert.equal(result.pendingAtEnd, 0);
  assert.equal(result.missingDeliveries, 0);
  if (!interruptSignal) assert(viewer.document.getMap("layers").get(idAt(49)).get("x") > batchBefore);
  assert.equal(viewer.document.getMap("layers").get(idAt(99)).get("x"), unchanged);
  assert(result.samples.every((entry) => entry.observedRoundTripMs.count === 1));
  process.stdout.write(`${JSON.stringify({ kind: "load-harness-check", changes: result.sentChanges,
    deliveries: result.propagationMs.count, pending: result.pendingAtEnd, readonly: true, persisted: clients.every((client) => client.isPersisted()) })}\n`);
  if (interruptSignal) {
    assert.equal(result.interrupted, true);
    assert.equal(process.exitCode, 1);
    assert(result.actualEditsPerWriterHz >= editHz * 0.95);
    process.stdout.write(`${JSON.stringify({ kind: "load-interruption-check", signal: interruptSignal,
      interrupted: true, persisted: clients.every((client) => client.isPersisted()), pending: result.pendingAtEnd,
      cadenceAtLeast95Percent: true, requestedSeconds: 30, steadySeconds: result.steadyDurationSeconds })}\n`);
  }
} finally {
  await Promise.allSettled(clients.map((client) => client.close()));
  await server.destroy();
  removeInterruptHandlers();
}
