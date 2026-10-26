// @vitest-environment node

import { randomUUID } from "node:crypto";

import { escapeIdentifier, Pool } from "pg";
import type { PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { waitFor } from "../collaboration-server/__tests__/helpers";
import { createPostgresRepository } from "../collaboration-server/postgres-repository";
import { DocumentRemovedError } from "../collaboration-server/types";
import { assertAssetQuota, assertDocumentQuota } from "../server/quotas";

const databaseUrl = process.env.RIMO_TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const schema = `rimo_lock_test_${randomUUID().replaceAll("-", "")}`;
let admin: Pool;
let database: Pool;
let persistencePool: Pool;

async function transaction(client: PoolClient, operation: () => Promise<unknown>): Promise<void> {
  try { await operation(); await client.query("COMMIT"); }
  catch (error) { await client.query("ROLLBACK"); throw error; }
}

async function waitUntilBlocked(waitingPid: number, blockingPid: number): Promise<void> {
  const deadline = performance.now() + 3_000;
  while (performance.now() < deadline) {
    const state = await database.query<{ blocked: boolean }>(
      "SELECT $2::integer = ANY(pg_blocking_pids($1::integer)) AS blocked", [waitingPid, blockingPid],
    );
    if (state.rows[0].blocked) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Expected PostgreSQL lock dependency did not appear");
}

describe.skipIf(!databaseUrl)("snapshot persistence lock order", () => {
  beforeAll(async () => {
    admin = new Pool({ connectionString: databaseUrl });
    await admin.query(`CREATE SCHEMA ${escapeIdentifier(schema)}`);
    const options = { connectionString: databaseUrl, options: `-c search_path=${schema}`,
      connectionTimeoutMillis: 3_000, statement_timeout: 8_000 };
    database = new Pool({ ...options, max: 5 });
    persistencePool = new Pool({ ...options, max: 1 });
    await database.query("CREATE TABLE boards(id uuid PRIMARY KEY, owner_id uuid NOT NULL)");
    await database.query("CREATE TABLE assets(board_id uuid REFERENCES boards(id), byte_size bigint NOT NULL)");
    await database.query(`CREATE TABLE board_documents(
      board_id uuid PRIMARY KEY REFERENCES boards(id) ON DELETE CASCADE,
      state bytea NOT NULL, revision bigint NOT NULL DEFAULT 0,
      saved_at timestamptz NOT NULL DEFAULT now()
    )`);
  });

  afterAll(async () => {
    await persistencePool.end(); await database.end();
    if (!/^rimo_lock_test_[a-f0-9]{32}$/.test(schema)) throw new Error("Unexpected persistence lock test schema");
    await admin.query(`DROP SCHEMA IF EXISTS ${escapeIdentifier(schema)} CASCADE`);
    await admin.end();
  });

  it("finishes upload, archive import and the first snapshot without the board/assets/documents lock cycle", async () => {
    const ownerId = randomUUID();
    const boardId = randomUUID();
    const restoredBoard = randomUUID();
    await database.query("INSERT INTO boards(id,owner_id) VALUES($1,$2)", [boardId, ownerId]);
    const upload = await database.connect();
    const archive = await database.connect();
    const uploadPid = (await upload.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0].pid;
    const archivePid = (await archive.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0].pid;
    const persistencePid = (await persistencePool.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0].pid;
    let saving: Promise<unknown> | undefined;
    let uploading: Promise<unknown> | undefined;
    let restoring: Promise<unknown> | undefined;
    try {
      await upload.query("BEGIN");
      await upload.query("SELECT id FROM boards WHERE id=$1 FOR UPDATE", [boardId]);
      await archive.query("BEGIN");
      await archive.query("INSERT INTO boards(id,owner_id) VALUES($1,$2)", [restoredBoard, ownerId]);
      await assertAssetQuota(archive, { boardId: restoredBoard, ownerId, additionalBytes: 1 });
      expect(await createPostgresRepository(persistencePool).load(boardId)).toBeNull();
      saving = createPostgresRepository(persistencePool).save(boardId, new Uint8Array([1, 2, 3]));
      await waitUntilBlocked(persistencePid, uploadPid);
      uploading = transaction(upload, async () => {
        await assertAssetQuota(upload, { boardId, ownerId, additionalBytes: 1 });
        await upload.query("INSERT INTO assets(board_id,byte_size) VALUES($1,1)", [boardId]);
      });
      await waitUntilBlocked(uploadPid, archivePid);
      restoring = transaction(archive, async () => {
        await archive.query("INSERT INTO assets(board_id,byte_size) VALUES($1,1)", [restoredBoard]);
        await assertDocumentQuota(archive, restoredBoard, 1);
        await archive.query("INSERT INTO board_documents(board_id,state,revision) VALUES($1,$2,1)", [restoredBoard, Buffer.from([4])]);
      });
      const results = await Promise.allSettled([saving, uploading, restoring]);
      expect(results.map((result) => result.status)).toEqual(["fulfilled", "fulfilled", "fulfilled"]);
      const stored = await createPostgresRepository(persistencePool).load(boardId);
      expect(stored?.revision).toBe(1);
      expect(stored?.state).toEqual(new Uint8Array([1, 2, 3]));
      expect((await database.query("SELECT count(*) FROM assets WHERE board_id=ANY($1::uuid[])", [[boardId, restoredBoard]])).rows[0].count).toBe("2");
    } finally {
      await Promise.allSettled([upload.query("ROLLBACK"), archive.query("ROLLBACK")]);
      await Promise.allSettled([saving, uploading, restoring].filter((entry): entry is Promise<unknown> => !!entry));
      upload.release(); archive.release();
    }
  }, 20_000);

  it("rejects an absent board before waiting for a document budget held by another transaction", async () => {
    const blocker = await database.connect();
    let settled = false;
    let result: unknown;
    let saving: Promise<void> | undefined;
    try {
      await blocker.query("BEGIN");
      await assertDocumentQuota(blocker, randomUUID(), 1);
      saving = createPostgresRepository(persistencePool).save(randomUUID(), new Uint8Array([5]))
        .then(() => { settled = true; }, (error: unknown) => { result = error; settled = true; });
      await waitFor(() => settled, 1_000);
      await saving;
      expect(result).toBeInstanceOf(DocumentRemovedError);
    } finally { await blocker.query("ROLLBACK"); await saving; blocker.release(); }
  });
});
