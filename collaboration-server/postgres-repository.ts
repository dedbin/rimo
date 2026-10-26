import { Buffer } from "node:buffer";

import type { Pool } from "pg";
import { assertDocumentQuota } from "../server/quotas";

import { DocumentRemovedError } from "./types";
import type { SnapshotRepository, StoredDocument } from "./types";

interface DocumentRow {
  state: Buffer;
  revision: string;
  saved_at: Date;
}

function metadata(row: Pick<DocumentRow, "revision" | "saved_at">): Omit<StoredDocument, "state"> {
  const revision = Number(row.revision);
  if (!Number.isSafeInteger(revision) || revision < 0) {
    throw new Error("Invalid document revision");
  }
  return { revision, savedAt: new Date(row.saved_at) };
}

export function createPostgresRepository(pool: Pool): SnapshotRepository {
  return {
    async load(boardId) {
      const result = await pool.query<DocumentRow>(
        "SELECT state, revision, saved_at FROM board_documents WHERE board_id = $1",
        [boardId],
      );
      const row = result.rows[0];
      return row ? { state: new Uint8Array(row.state), ...metadata(row) } : null;
    },

    async save(boardId, state) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await assertDocumentQuota(client, boardId, state.byteLength);
        const result = await client.query<DocumentRow>(
          `INSERT INTO board_documents (board_id, state, revision, saved_at)
           VALUES ($1, $2, 1, clock_timestamp())
           ON CONFLICT (board_id) DO UPDATE
           SET state = EXCLUDED.state,
               revision = board_documents.revision + 1,
               saved_at = clock_timestamp()
           RETURNING revision, saved_at`,
          [boardId, Buffer.from(state)],
        );
        const saved = metadata(result.rows[0]);
        // A successful query is not a durability acknowledgement until COMMIT returns.
        await client.query("COMMIT");
        return saved;
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        if (typeof error === "object" && error !== null && "code" in error && error.code === "23503") {
          throw new DocumentRemovedError();
        }
        throw error;
      } finally {
        client.release();
      }
    },

    async health() {
      try {
        await pool.query("SELECT 1");
        return true;
      } catch {
        return false;
      }
    },
  };
}
