import { createHash, randomUUID } from "node:crypto";

import type { AssetSummary } from "../types/service";
import { isUuid, requireBoardAccess } from "./access";
import { readStoredAsset, removeStoredAsset, storeAsset } from "./asset-storage";
import { getPool } from "./db";
import { HttpError } from "./http-error";
import { assertAssetQuota } from "./quotas";

const MAX_COPY_BYTES = 32 * 1024 * 1024;
const MAX_COPY_ASSETS = 100;

interface CopyAssetRow {
  id: string;
  board_id: string;
  storage_key: string;
  sha256: string;
  byte_size: string;
  width: number;
  height: number;
  mime_type: string;
}

function unavailable(): HttpError {
  return new HttpError(404, "ASSET_NOT_FOUND", "Исходное изображение недоступно. Вставка отменена.");
}

function summarize(row: CopyAssetRow): AssetSummary {
  return { id: row.id, url: `/api/assets/${row.id}`, mimeType: row.mime_type,
    width: row.width, height: row.height, size: Number(row.byte_size) };
}

function parseAssetIds(input: unknown): string[] {
  if (!Array.isArray(input) || !input.length || input.length > MAX_COPY_ASSETS ||
      input.some((id) => typeof id !== "string" || !isUuid(id))) {
    throw new HttpError(400, "INVALID_ASSETS", `За одну вставку можно перенести до ${MAX_COPY_ASSETS} изображений.`);
  }
  return [...new Set((input as string[]).map((id) => id.toLowerCase()))];
}

/** Copies immutable image bytes into the destination's access and quota boundary. */
export async function copyBoardAssets(
  boardId: string, userId: string, input: unknown,
): Promise<Readonly<Record<string, AssetSummary>>> {
  await requireBoardAccess(boardId, userId, "edit");
  const ids = parseAssetIds(input);
  const pool = getPool();
  const initial = await pool.query<{ board_id: string }>(
    "SELECT DISTINCT board_id FROM assets WHERE id = ANY($1::uuid[])", [ids],
  );
  const boardIds = [...new Set([boardId, ...initial.rows.map((row) => row.board_id)])].sort();
  const client = await pool.connect();
  const written: string[] = [];
  let commitAttempted = false;
  try {
    await client.query("BEGIN");
    // A stable order also handles two teachers copying in opposite directions.
    const boards = await client.query<{ id: string; owner_id: string }>(
      "SELECT id, owner_id FROM boards WHERE id = ANY($1::uuid[]) ORDER BY id FOR UPDATE", [boardIds],
    );
    const destination = boards.rows.find((board) => board.id === boardId);
    if (!destination) throw unavailable();
    await requireBoardAccess(boardId, userId, "edit");
    for (const source of initial.rows) await requireBoardAccess(source.board_id, userId);
    const sourceRows = await client.query<CopyAssetRow>(
      "SELECT * FROM assets WHERE id = ANY($1::uuid[])", [ids],
    );
    if (sourceRows.rows.length !== ids.length) throw unavailable();
    const totalBytes = sourceRows.rows.reduce((total, row) => total + Number(row.byte_size), 0);
    if (!Number.isSafeInteger(totalBytes) || totalBytes > MAX_COPY_BYTES) {
      throw new HttpError(413, "COPY_TOO_LARGE", "За одну вставку можно перенести до 32 МиБ изображений.");
    }
    const existing = await client.query<CopyAssetRow>(
      "SELECT * FROM assets WHERE board_id = $1 AND sha256 = ANY($2::text[])",
      [boardId, sourceRows.rows.map((row) => row.sha256)],
    );
    const byHash = new Map(existing.rows.map((row) => [row.sha256, row]));
    const missing = new Map<string, CopyAssetRow>();
    for (const row of sourceRows.rows) if (!byHash.has(row.sha256)) missing.set(row.sha256, row);
    await assertAssetQuota(client, { boardId, ownerId: destination.owner_id,
      additionalBytes: [...missing.values()].reduce((total, row) => total + Number(row.byte_size), 0) });
    for (const source of missing.values()) {
      const bytes = await readStoredAsset(source.storage_key).catch(() => { throw unavailable(); });
      if (bytes.length !== Number(source.byte_size) || createHash("sha256").update(bytes).digest("hex") !== source.sha256) {
        throw unavailable();
      }
      const id = randomUUID();
      const storageKey = `${id}.webp`;
      await storeAsset(storageKey, bytes);
      written.push(storageKey);
      const inserted = await client.query<CopyAssetRow>(
        `INSERT INTO assets(id,board_id,uploaded_by,storage_key,sha256,mime_type,byte_size,width,height)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
        [id, boardId, userId, storageKey, source.sha256, source.mime_type, bytes.length, source.width, source.height],
      );
      byHash.set(source.sha256, inserted.rows[0]);
    }
    const result = Object.fromEntries(sourceRows.rows.map((row) => [row.id, summarize(byHash.get(row.sha256)!)]));
    commitAttempted = true;
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    if (!commitAttempted) {
      const cleanup = await Promise.allSettled(written.map(removeStoredAsset));
      if (cleanup.some((result) => result.status === "rejected")) console.error("Asset copy cleanup incomplete");
    } else if (written.length) {
      // A lost COMMIT response must never remove possibly committed image bytes.
      console.error("Asset copy commit uncertain; retained files for recovery", { count: written.length });
    }
    throw error;
  } finally { client.release(); }
}
