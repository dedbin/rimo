// @vitest-environment node

import { randomUUID } from "node:crypto";

import type { Server } from "@hocuspocus/server";
import { escapeIdentifier, Pool } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { createTestClient, insertRectangle, ORIGIN, waitFor } from "../collaboration-server/__tests__/helpers";
import type { TestClient } from "../collaboration-server/__tests__/helpers";
import { createPostgresRepository } from "../collaboration-server/postgres-repository";
import { createCollaborationServer } from "../collaboration-server/server";
import type { CollaborationContext } from "../collaboration-server/types";

const databaseUrl = process.env.RIMO_TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const schema = `rimo_deleted_test_${randomUUID().replaceAll("-", "")}`;
const servers: Server<CollaborationContext>[] = [];
const clients: TestClient[] = [];
const unblock: (() => void)[] = [];
let admin: Pool;
let database: Pool;

async function newBoard(): Promise<string> {
  const boardId = randomUUID();
  await database.query("INSERT INTO boards(id) VALUES ($1)", [boardId]);
  return boardId;
}

async function fixture() {
  const boardId = await newBoard();
  const repository = createPostgresRepository(database);
  let blockWrites = false;
  let saveStarted = false;
  let removed = false;
  let removedWrites = 0;
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  unblock.push(release);
  const server = createCollaborationServer({
    origins: [ORIGIN], port: 0,
    limits: { maxOpenDocuments: 1, maxEditors: 1, aclRefreshMs: 5_000,
      persistenceDebounceMs: 20, persistenceMaxDebounceMs: 50 },
  }, {
    repository: {
      ...repository,
      async save(id, state) {
        if (id === boardId && blockWrites) { saveStarted = true; await gate; }
        if (id === boardId && removed) removedWrites += 1;
        return repository.save(id, state);
      },
    },
    async authenticate(_headers, requestedBoard) {
      const exists = await database.query("SELECT 1 FROM boards WHERE id = $1", [requestedBoard]);
      return exists.rowCount ? { boardId: requestedBoard, userId: "editor", sessionId: "editor", name: "Editor", role: "editor" } : null;
    },
    async revalidate(principal) {
      const exists = await database.query("SELECT 1 FROM boards WHERE id = $1", [principal.boardId]);
      return exists.rowCount ? "editor" : null;
    },
  });
  await server.listen();
  servers.push(server);
  async function connect(id: string) {
    const client = createTestClient(`ws://127.0.0.1:${server.address.port}`, "editor", id);
    clients.push(client);
    await client.connect();
    await waitFor(() => client.isPersisted());
    return client;
  }
  const client = await connect(boardId);
  let closeReason = "";
  client.provider.on("close", ({ event }: { event: { reason?: string } }) => {
    closeReason = event.reason || closeReason;
    client.websocketProvider.disconnect();
  });
  return {
    server, client, boardId, connect, release,
    removedWrites: () => removedWrites,
    closeReason: () => closeReason,
    async removeDuringSave() {
      blockWrites = true;
      insertRectangle(client.document, "pending");
      await waitFor(() => saveStarted);
      await database.query("DELETE FROM boards WHERE id = $1", [boardId]);
      removed = true;
    },
  };
}

describe.skipIf(!databaseUrl)("deleted board persistence lifecycle", () => {
  beforeAll(async () => {
    admin = new Pool({ connectionString: databaseUrl });
    await admin.query(`CREATE SCHEMA ${escapeIdentifier(schema)}`);
    database = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}` });
    await database.query("CREATE TABLE boards(id uuid PRIMARY KEY)");
    await database.query(`CREATE TABLE board_documents(
      board_id uuid PRIMARY KEY REFERENCES boards(id) ON DELETE CASCADE,
      state bytea NOT NULL, revision bigint NOT NULL DEFAULT 0,
      saved_at timestamptz NOT NULL DEFAULT now()
    )`);
  });

  afterEach(async () => {
    unblock.splice(0).forEach((release) => release());
    clients.splice(0).forEach((client) => client.destroy());
    await Promise.all(servers.splice(0).map((server) => server.destroy()));
    await database.query("TRUNCATE board_documents, boards CASCADE");
  });

  afterAll(async () => {
    await database.end();
    if (!/^rimo_deleted_test_[a-f0-9]{32}$/.test(schema)) throw new Error("Unexpected deleted-board test schema");
    await admin.query(`DROP SCHEMA IF EXISTS ${escapeIdentifier(schema)} CASCADE`);
    await admin.end();
  });

  it("unloads a deleted room, releases its only room/editor slot and does not retry its failed write", async () => {
    const context = await fixture();
    const oldRevision = context.client.lastAcknowledgement()!.revision;
    const deletedDocument = context.server.hocuspocus.documents.get(context.boardId)!;
    await context.removeDuringSave();
    context.release();
    await waitFor(() => !context.server.hocuspocus.documents.has(context.boardId) && context.closeReason() !== "");
    expect(context.closeReason()).toBe("Board removed");
    expect(deletedDocument.isDestroyed).toBe(true);
    expect(context.client.lastAcknowledgement()!.revision).toBe(oldRevision);
    expect((await database.query("SELECT 1 FROM board_documents WHERE board_id = $1", [context.boardId])).rowCount).toBe(0);
    const next = await context.connect(await newBoard());
    insertRectangle(next.document, "next-room");
    await waitFor(() => next.isPersisted());
    expect(context.server.hocuspocus.documents.size).toBe(1);
    const writes = context.removedWrites();
    expect(writes).toBe(1);
    await new Promise((resolve) => setTimeout(resolve, 2_100));
    expect(context.removedWrites()).toBe(writes);
    expect((await fetch(`http://127.0.0.1:${context.server.address.port}/healthz`)).status).toBe(200);
  });

  it("finishes graceful shutdown when a board disappears while its store is pending", async () => {
    const context = await fixture();
    await context.removeDuringSave();
    let shutdownFinished = false;
    const shutdown = context.server.destroy().then(() => { shutdownFinished = true; });
    context.release();
    await waitFor(() => shutdownFinished, 1_000);
    await shutdown;
    expect(context.server.hocuspocus.getDocumentsCount()).toBe(0);
    expect(context.removedWrites()).toBe(1);
    servers.splice(servers.indexOf(context.server), 1);
  });
});
