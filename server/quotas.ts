import type { PoolClient } from "pg";

import { getQuotaLimits } from "./config";
import { inTransaction } from "./db";
import { HttpError } from "./http-error";

async function lockBudget(client: PoolClient, resource: string): Promise<void> {
  await client.query(
    `SELECT pg_advisory_xact_lock(
       hashtext(current_database() || ':' || current_schema()), hashtext($1)
     )`,
    [`rimo-quota:${resource}`],
  );
}

function validateByteCount(bytes: number): void {
  if (!Number.isSafeInteger(bytes) || bytes < 0) throw new Error("Invalid quota byte count");
}

export async function withOwnerQuota<T>(create: () => Promise<T>): Promise<T> {
  const limits = getQuotaLimits();
  return inTransaction(async (client) => {
    await lockBudget(client, "owners");
    const usage = await client.query<{ total: string }>(
      'SELECT count(*) AS total FROM "user" WHERE "isAnonymous" = false',
    );
    if (BigInt(usage.rows[0].total) >= BigInt(limits.maxOwners)) {
      throw new HttpError(409, "OWNER_LIMIT_REACHED", `Достигнут лимит аккаунтов владельцев: ${limits.maxOwners}.`);
    }
    return create();
  });
}

// Call inside the transaction that inserts the new board.
export async function assertBoardQuota(client: PoolClient, ownerId: string): Promise<void> {
  const limits = getQuotaLimits();
  await lockBudget(client, `boards:${ownerId}`);
  const usage = await client.query<{ total: string }>(
    "SELECT count(*) AS total FROM boards WHERE owner_id = $1", [ownerId],
  );
  if (BigInt(usage.rows[0].total) >= BigInt(limits.maxBoardsPerOwner)) {
    throw new HttpError(409, "BOARD_LIMIT_REACHED", `Достигнут лимит досок владельца: ${limits.maxBoardsPerOwner}.`);
  }
}

export interface AssetQuotaChange {
  readonly boardId: string;
  readonly ownerId: string;
  readonly additionalBytes: number;
}

// The board owner must come from the locked board row, never from request input.
// Keep this lock until all corresponding asset rows have been inserted and committed.
export async function assertAssetQuota(client: PoolClient, change: AssetQuotaChange): Promise<void> {
  validateByteCount(change.additionalBytes);
  const limits = getQuotaLimits();
  if (change.additionalBytes === 0) return;
  await lockBudget(client, "assets");
  const usage = await client.query<{ global_bytes: string; owner_bytes: string; board_bytes: string }>(
    `SELECT COALESCE(sum(a.byte_size), 0) AS global_bytes,
       COALESCE(sum(a.byte_size) FILTER (WHERE b.owner_id = $1), 0) AS owner_bytes,
       COALESCE(sum(a.byte_size) FILTER (WHERE a.board_id = $2), 0) AS board_bytes
     FROM assets a JOIN boards b ON b.id = a.board_id`,
    [change.ownerId, change.boardId],
  );
  const additional = BigInt(change.additionalBytes);
  const row = usage.rows[0];
  if (BigInt(row.board_bytes) + additional > BigInt(limits.maxBoardAssetBytes)) {
    throw new HttpError(413, "ASSET_QUOTA_EXCEEDED", "Закончился лимит изображений на доске.");
  }
  if (BigInt(row.owner_bytes) + additional > BigInt(limits.maxOwnerAssetBytes)) {
    throw new HttpError(413, "OWNER_ASSET_QUOTA_EXCEEDED", "Закончился общий лимит изображений владельца.");
  }
  if (BigInt(row.global_bytes) + additional > BigInt(limits.maxGlobalAssetBytes)) {
    throw new HttpError(413, "GLOBAL_ASSET_QUOTA_EXCEEDED", "Закончился лимит хранения изображений сервиса.");
  }
}

// Call after BEGIN and before replacing board_documents.state on the same client.
export async function assertDocumentQuota(client: PoolClient, boardId: string, nextBytes: number): Promise<void> {
  validateByteCount(nextBytes);
  const limits = getQuotaLimits();
  await lockBudget(client, "documents");
  const usage = await client.query<{ total: string; previous: string }>(
    `SELECT COALESCE(sum(octet_length(state)), 0) AS total,
       COALESCE(max(octet_length(state)) FILTER (WHERE board_id = $1), 0) AS previous
     FROM board_documents`,
    [boardId],
  );
  const previous = BigInt(usage.rows[0].previous);
  const next = BigInt(nextBytes);
  if (next <= previous) return;
  if (BigInt(usage.rows[0].total) - previous + next > BigInt(limits.maxGlobalDocumentBytes)) {
    throw new HttpError(413, "GLOBAL_DOCUMENT_QUOTA_EXCEEDED", "Закончился лимит хранения документов сервиса.");
  }
}
