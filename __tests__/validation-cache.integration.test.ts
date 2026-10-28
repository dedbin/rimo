// @vitest-environment node

import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import type { Server } from "@hocuspocus/server";
import { escapeIdentifier, Pool } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";

import { createTestClient, insertRectangle, ORIGIN, waitFor } from "../collaboration-server/__tests__/helpers";
import type { TestClient } from "../collaboration-server/__tests__/helpers";
import { createPostgresRepository } from "../collaboration-server/postgres-repository";
import { createCollaborationServer } from "../collaboration-server/server";
import type { CollaborationContext } from "../collaboration-server/types";
import { ValidationCache } from "../collaboration-server/validation-cache";

const databaseUrl = process.env.RIMO_TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const schema = `rimo_validation_test_${randomUUID().replaceAll("-", "")}`;
const clients: TestClient[] = [];
let admin: Pool;
let database: Pool;
let server: Server<CollaborationContext> | undefined;

function layer(client: TestClient): Y.Map<unknown> {
  return client.document.getMap<Y.Map<unknown>>("layers").get("rectangle")!;
}

async function connect(boardId: string, name: string): Promise<TestClient> {
  const client = createTestClient(`ws://127.0.0.1:${server!.address.port}`, name, boardId);
  clients.push(client);
  await client.connect();
  await waitFor(() => client.isPersisted());
  return client;
}

describe.skipIf(!databaseUrl)("validation cache through real WebSocket and PostgreSQL", () => {
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
    clients.splice(0).forEach((client) => client.destroy());
    await server?.destroy(); server = undefined;
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    await database.end();
    if (!/^rimo_validation_test_[a-f0-9]{32}$/.test(schema)) throw new Error("Unexpected validation cache test schema");
    await admin.query(`DROP SCHEMA IF EXISTS ${escapeIdentifier(schema)} CASCADE`);
    await admin.end();
  });

  it("reuses a live shadow, isolates a rejected writer, accepts the next valid edit and reopens a room from durable state", async () => {
    const validating = vi.spyOn(ValidationCache.prototype, "validate");
    const boardId = randomUUID();
    await database.query("INSERT INTO boards(id) VALUES($1)", [boardId]);
    const repository = createPostgresRepository(database);
    server = createCollaborationServer({ origins: [ORIGIN], port: 0,
      limits: { persistenceDebounceMs: 20, persistenceMaxDebounceMs: 50 } }, {
      repository,
      async authenticate(headers, requested) {
        const userId = headers.get("cookie")?.split("=")[1];
        return requested === boardId && userId ? { boardId, userId, sessionId: userId, name: userId, role: "editor" } : null;
      },
      async revalidate() { return "editor"; },
    });
    await server.listen();
    const writer = await connect(boardId, "writer");
    const observer = await connect(boardId, "observer");
    insertRectangle(writer.document, "rectangle");
    await waitFor(() => observer.document.getMap("layers").has("rectangle") && writer.isPersisted());
    for (let value = 1; value <= 20; value += 1) {
      layer(writer).set("x", value);
      await waitFor(() => layer(observer).get("x") === value);
    }
    await waitFor(() => writer.isPersisted() && observer.isPersisted());
    const cache = validating.mock.contexts[0] as ValidationCache;
    expect(cache.statistics).toMatchObject({ size: 1, created: 1, rejected: 0 });
    expect(cache.statistics.reused).toBeGreaterThanOrEqual(20);
    const reuse = cache.statistics;
    const stored = await repository.load(boardId);
    let rejected = false;
    writer.provider.on("close", () => { rejected = true; writer.websocketProvider.disconnect(); });
    layer(writer).set("width", -1);
    await waitFor(() => rejected);
    expect(layer(observer).get("width")).toBe(100);
    const unchanged = await repository.load(boardId);
    expect(unchanged?.revision).toBe(stored?.revision);
    expect(unchanged?.state).toEqual(stored?.state);
    expect(cache.statistics).toMatchObject({ size: 0, rejected: 1 });
    const afterReject = cache.statistics;
    layer(observer).set("y", 77);
    await waitFor(() => observer.isPersisted());
    expect(layer(observer).toJSON()).toMatchObject({ width: 100, x: 20, y: 77 });
    expect(cache.statistics).toMatchObject({ size: 1, created: 2, rejected: 1 });
    const recovered = cache.statistics;
    const oldCanonical = server.hocuspocus.documents.get(boardId)!;
    clients.splice(0).forEach((client) => client.destroy());
    await waitFor(() => !server!.hocuspocus.documents.has(boardId));
    expect(oldCanonical.isDestroyed).toBe(true);
    expect(cache.statistics.size).toBe(0);
    const reopened = await connect(boardId, "reopened");
    expect(layer(reopened).toJSON()).toMatchObject({ width: 100, x: 20, y: 77 });
    layer(reopened).set("x", 123);
    await waitFor(() => reopened.isPersisted());
    expect(cache.statistics).toMatchObject({ size: 1, created: 3, rejected: 1 });
    const durable = new Y.Doc();
    Y.applyUpdate(durable, (await repository.load(boardId))!.state);
    expect(durable.getMap<Y.Map<unknown>>("layers").get("rectangle")!.toJSON()).toMatchObject({ width: 100, x: 123, y: 77 });
    durable.destroy();
    const output = path.resolve("temp/performance");
    await mkdir(output, { recursive: true });
    await writeFile(path.join(output, "validation-cache-flow.json"), JSON.stringify({ reuse, afterReject, recovered, reopened: cache.statistics }, null, 2), { mode: 0o600 });
  }, 20_000);
});
