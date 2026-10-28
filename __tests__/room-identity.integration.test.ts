// @vitest-environment node

import { randomBytes, randomUUID } from "node:crypto";

import { HocuspocusProvider, HocuspocusProviderWebsocket } from "@hocuspocus/provider";
import type { Server } from "@hocuspocus/server";
import { escapeIdentifier, Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import * as Y from "yjs";

import { insertRectangle, ORIGIN, waitFor } from "../collaboration-server/__tests__/helpers";
import { createCollaborationDependencies } from "../collaboration-server/dependencies";
import { createCollaborationServer } from "../collaboration-server/server";
import type { CollaborationContext } from "../collaboration-server/types";
import { parseServerMessage } from "../lib/collaboration/protocol";
import type { PersistedMessage } from "../lib/collaboration/protocol";
import { getAuth } from "../server/auth";
import { createBoard } from "../server/boards";
import { getPool } from "../server/db";
import { runMigrations } from "../server/migrations";
import { verifyFixtureOwner } from "./verified-owner-fixture";

const databaseUrl = process.env.RIMO_TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const schema = `rimo_room_identity_${randomUUID().replaceAll("-", "")}`;
const cleanup: (() => void)[] = [];
let admin: Pool;
let server: Server<CollaborationContext> | undefined;
let ownerId: string;
let cookie: string;

function start(boardId: string) {
  const document = new Y.Doc();
  let saved: PersistedMessage | undefined;
  let rejected = "";
  const websocket = new HocuspocusProviderWebsocket({
    url: `ws://127.0.0.1:${server!.address.port}`, autoConnect: false, maxAttempts: 1, jitter: false,
    WebSocketPolyfill: class extends WebSocket {
      constructor(address: string) { super(address, { headers: { Origin: ORIGIN, Cookie: cookie } }); }
    },
  });
  const provider = new HocuspocusProvider({
    name: boardId, document, token: "cookie", websocketProvider: websocket,
    onAuthenticationFailed({ reason }) { rejected = reason; websocket.disconnect(); },
    onStateless({ payload }) {
      const message = parseServerMessage(payload);
      if (message?.type === "persisted") saved = message;
    },
  });
  provider.attach();
  void websocket.connect().catch(() => undefined);
  let destroyed = false;
  function destroy() {
    if (destroyed) return;
    destroyed = true;
    provider.destroy(); websocket.destroy(); document.destroy();
  }
  cleanup.push(destroy);
  return {
    document, provider, destroy, rejection: () => rejected,
    isPersisted: () => !!saved && Y.equalSnapshots(Y.snapshot(document), Y.decodeSnapshot(Buffer.from(saved.snapshot, "base64"))),
  };
}

describe.skipIf(!databaseUrl)("canonical room identity with real cookies and PostgreSQL", () => {
  beforeAll(async () => {
    admin = new Pool({ connectionString: databaseUrl });
    await admin.query(`CREATE SCHEMA ${escapeIdentifier(schema)}`);
    const isolated = new URL(databaseUrl!);
    isolated.searchParams.set("options", `-c search_path=${schema}`);
    vi.stubEnv("DATABASE_URL", isolated.toString());
    vi.stubEnv("BETTER_AUTH_SECRET", randomBytes(32).toString("base64url"));
    vi.stubEnv("BETTER_AUTH_URL", ORIGIN);
    await runMigrations();
    const email = `${schema}@example.test`;
    const password = randomBytes(24).toString("base64url");
    const owner = await getAuth({ allowSignUp: true }).api.signUpEmail({ body: { email, password, name: "Room identity test" } });
    ownerId = owner.user.id;
    await verifyFixtureOwner(getPool(), ownerId);
    const response = await getAuth().handler(new Request(`${ORIGIN}/api/auth/sign-in/email`, {
      method: "POST", headers: { origin: ORIGIN, "content-type": "application/json" }, body: JSON.stringify({ email, password }),
    }));
    expect(response.status).toBe(200);
    cookie = response.headers.getSetCookie().map((value) => value.split(";")[0]).join("; ");
  }, 20_000);

  afterAll(async () => {
    cleanup.splice(0).forEach((destroy) => destroy());
    await server?.destroy();
    await getPool().end();
    if (!/^rimo_room_identity_[a-f0-9]{32}$/.test(schema)) throw new Error("Unexpected room-identity test schema");
    await admin.query(`DROP SCHEMA IF EXISTS ${escapeIdentifier(schema)} CASCADE`);
    await admin.end();
    vi.unstubAllEnvs();
  });

  it("rejects uppercase before authentication and prevents a second document from overwriting an acknowledged lower-case edit", async () => {
    const board = await createBoard(ownerId, "Room identity regression");
    const uppercase = board.id.toUpperCase();
    expect(uppercase).not.toBe(board.id);
    const dependencies = createCollaborationDependencies();
    // PostgreSQL uuid and the real ACL accept either case; the WS boundary must not.
    expect((await dependencies.authenticate(new Headers({ cookie }), uppercase))?.boardId).toBe(uppercase);
    const authenticating = vi.spyOn(dependencies, "authenticate");
    const loading = vi.spyOn(dependencies.repository, "load");
    const writing = vi.spyOn(dependencies.repository, "save");
    server = createCollaborationServer({ origins: [ORIGIN], port: 0,
      limits: { persistenceDebounceMs: 20, persistenceMaxDebounceMs: 50 } }, dependencies);
    await server.listen();
    const lower = start(board.id);
    await waitFor(() => lower.provider.isSynced && lower.isPersisted());
    const alias = start(uppercase);
    await waitFor(() => alias.provider.isSynced || !!alias.rejection());
    insertRectangle(lower.document, "acknowledged-lower-edit");
    await waitFor(() => lower.isPersisted());
    // On the vulnerable server this stale second document overwrites the same row.
    if (alias.provider.isSynced) {
      insertRectangle(alias.document, "uppercase-overwrite");
      await waitFor(() => alias.isPersisted());
    }
    const saved = await dependencies.repository.load(board.id);
    const restored = new Y.Doc();
    try {
      Y.applyUpdate(restored, saved!.state);
      expect(restored.getMap("layers").has("acknowledged-lower-edit")).toBe(true);
      expect(restored.getMap("layers").has("uppercase-overwrite")).toBe(false);
    } finally { restored.destroy(); }
    expect(lower.isPersisted()).toBe(true);
    expect(alias.rejection()).toBe("Board or origin is not allowed");
    expect(authenticating.mock.calls.some((call) => call[1] === uppercase)).toBe(false);
    expect(loading.mock.calls.some((call) => call[0] === uppercase)).toBe(false);
    expect(writing.mock.calls.every((call) => call[0] === board.id)).toBe(true);
    expect(server.hocuspocus.documents.size).toBe(1);
    lower.destroy(); alias.destroy();
    await waitFor(() => server!.hocuspocus.documents.size === 0);
    const reopened = start(board.id);
    await waitFor(() => reopened.provider.isSynced && reopened.isPersisted());
    expect(reopened.document.getMap("layers").has("acknowledged-lower-edit")).toBe(true);
    expect(reopened.document.getMap("layers").has("uppercase-overwrite")).toBe(false);
  }, 15_000);
});
