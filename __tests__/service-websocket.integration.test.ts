// @vitest-environment node

import { randomBytes, randomUUID } from "node:crypto";

import { HocuspocusProvider, HocuspocusProviderWebsocket } from "@hocuspocus/provider";
import type { Server } from "@hocuspocus/server";
import WebSocket from "ws";
import * as Y from "yjs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createCollaborationDependencies } from "../collaboration-server/dependencies";
import { createCollaborationServer } from "../collaboration-server/server";
import type { CollaborationContext } from "../collaboration-server/types";
import { insertRectangle, waitFor } from "../collaboration-server/__tests__/helpers";
import { parseServerMessage } from "../lib/collaboration/protocol";
import type { PersistedMessage } from "../lib/collaboration/protocol";
import { getAuth } from "../server/auth";
import { createBoard, deleteBoard } from "../server/boards";
import { getPool } from "../server/db";
import { acceptInvite, createInvite, revokeInvite } from "../server/invites";
import { runMigrations } from "../server/migrations";

const databaseUrl = process.env.RIMO_TEST_DATABASE_URL;
const origin = "http://localhost:3000";
const clients: ReturnType<typeof connectClient>[] = [];
const userIds: string[] = [];
let server: Server<CollaborationContext> | undefined;
let boardId: string;
let ownerId: string;
let ownerCookie: string;
let guestCookie: string;
let guestId: string;
let inviteId: string;

async function authenticate(path: string, body: Record<string, unknown>): Promise<{ cookie: string; userId: string }> {
  const response = await getAuth().handler(new Request(`${origin}/api/auth${path}`, {
    method: "POST", headers: { "content-type": "application/json", origin }, body: JSON.stringify(body),
  }));
  expect(response.status).toBe(200);
  const result = await response.json() as { user: { id: string } };
  return {
    cookie: response.headers.getSetCookie().map((cookie) => cookie.split(";")[0]).join("; "),
    userId: result.user.id,
  };
}

function connectClient(cookie: string) {
  if (!server) throw new Error("Test collaboration server is not running");
  const document = new Y.Doc();
  let acknowledgement: PersistedMessage | null = null;
  let closed = false;
  let failure: string | null = null;
  let status = "initial";
  let messages = 0;
  const websocket = new HocuspocusProviderWebsocket({
    url: `ws://127.0.0.1:${server.address.port}`, autoConnect: false, maxAttempts: 1,
    jitter: false, initialDelay: 0,
    WebSocketPolyfill: class extends WebSocket {
      constructor(address: string) {
        super(address, { headers: { Origin: origin, Cookie: cookie } });
      }
    },
  });
  const provider = new HocuspocusProvider({
    name: boardId, token: "cookie", document, websocketProvider: websocket,
    onStateless({ payload }) {
      const message = parseServerMessage(payload);
      if (message?.type === "persisted") acknowledgement = message;
    },
    onClose() { closed = true; websocket.disconnect(); },
    onAuthenticationFailed({ reason }) { failure = `Authentication failed: ${reason}`; },
    onStatus(event) { status = event.status; },
    onMessage() { messages += 1; },
  });
  provider.attach();
  return {
    document, provider,
    async connect(): Promise<void> {
      if (!cookie) throw new Error("Authentication did not issue a cookie");
      void websocket.connect().catch(() => { failure = "WebSocket transport failed"; });
      try {
        await waitFor(() => provider.isSynced || failure !== null || closed, 5_000);
      } catch {
        throw new Error(`Handshake stalled: status=${status}, messages=${messages}`);
      }
      if (failure || closed) throw new Error(failure ?? "WebSocket closed during authentication");
      provider.sendStateless('{"type":"persistence-status"}');
    },
    isSaved(): boolean {
      return !!acknowledgement && Y.equalSnapshots(
        Y.snapshot(document), Y.decodeSnapshot(Buffer.from(acknowledgement.snapshot, "base64")),
      );
    },
    isClosed(): boolean { return closed; },
    destroy(): void { provider.destroy(); websocket.destroy(); document.destroy(); },
  };
}

describe.skipIf(!databaseUrl)("Better Auth cookies with PostgreSQL and WebSocket ACL", () => {
  beforeAll(async () => {
    process.env.DATABASE_URL = databaseUrl;
    process.env.BETTER_AUTH_SECRET = randomBytes(32).toString("base64url");
    process.env.BETTER_AUTH_URL = origin;
    await runMigrations();
    const email = `websocket-owner-${randomUUID()}@example.test`;
    const password = randomBytes(24).toString("base64url");
    const created = await getAuth({ allowSignUp: true }).api.signUpEmail({
      body: { email, password, name: "Преподаватель" },
    });
    ownerId = created.user.id;
    userIds.push(ownerId);
    ownerCookie = (await authenticate("/sign-in/email", { email, password })).cookie;
    const anonymous = await authenticate("/sign-in/anonymous", {});
    guestCookie = anonymous.cookie;
    guestId = anonymous.userId;
    userIds.push(guestId);
    boardId = (await createBoard(ownerId, "Проверка подключения" )).id;
    const createdInvite = await createInvite(boardId, ownerId, "editor");
    inviteId = createdInvite.invite.id;
    await acceptInvite(guestId, createdInvite.token, "Ученик", true);
    server = createCollaborationServer({
      port: 0, origins: [origin],
      limits: { aclRefreshMs: 100, aclCheckTimeoutMs: 300, persistenceDebounceMs: 25, persistenceMaxDebounceMs: 50 },
    }, createCollaborationDependencies());
    await server.listen();
  }, 30_000);

  afterAll(async () => {
    clients.forEach((client) => client.destroy());
    if (server) await server.destroy();
    if (boardId) await deleteBoard(boardId, ownerId);
    if (userIds.length) await getPool().query('DELETE FROM "user" WHERE id = ANY($1::text[])', [userIds]);
    await getPool().end();
  });

  it("authenticates actual cookies, commits shared edits and disconnects revoked guests", async () => {
    const owner = connectClient(ownerCookie);
    const invitedGuest = connectClient(guestCookie);
    clients.push(owner, invitedGuest);
    await Promise.all([owner.connect(), invitedGuest.connect()]);
    expect(owner.provider.authorizedScope).toBe("read-write");
    expect(invitedGuest.provider.authorizedScope).toBe("read-write");
    insertRectangle(invitedGuest.document, "shared", 42);
    await waitFor(() => owner.document.getMap("layers").has("shared") && invitedGuest.isSaved());
    const stored = await getPool().query<{ state: Buffer }>(
      "SELECT state FROM board_documents WHERE board_id = $1", [boardId],
    );
    const restored = new Y.Doc();
    Y.applyUpdate(restored, stored.rows[0].state);
    expect(restored.getMap<Y.Map<unknown>>("layers").get("shared")?.get("x")).toBe(42);
    restored.destroy();
    await revokeInvite(boardId, ownerId, inviteId);
    await waitFor(() => invitedGuest.isClosed(), 2_000);
    expect(owner.isClosed()).toBe(false);
    const count = await getPool().query<{ count: string }>(
      'SELECT count(*) FROM session WHERE "userId" = $1', [guestId],
    );
    expect(Number(count.rows[0].count)).toBeGreaterThan(0);
  }, 10_000);
});
