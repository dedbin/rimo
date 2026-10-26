import { randomUUID } from "node:crypto";

import type { BoardRole, BoardSummary } from "../types/service";
import { requireBoardAccess } from "./access";
import { getPool, inTransaction } from "./db";
import { HttpError } from "./http-error";
import { removeStoredAsset } from "./asset-storage";

interface BoardRow {
  id: string;
  title: string;
  owner_id: string;
  author_name: string;
  image_url: string;
  created_at: Date;
  updated_at: Date;
  is_favorite: boolean;
  role: BoardRole;
}

function summarize(row: BoardRow): BoardSummary {
  return {
    id: row.id,
    title: row.title,
    ownerId: row.owner_id,
    authorName: row.author_name,
    imageUrl: row.image_url,
    createdAt: row.created_at.getTime(),
    updatedAt: row.updated_at.getTime(),
    isFavorite: row.is_favorite,
    role: row.role,
  };
}

export function parseBoardTitle(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.trim().length > 100) {
    throw new HttpError(400, "INVALID_TITLE", "Название должно содержать от 1 до 100 символов.");
  }
  return value.trim();
}

export async function listBoards(
  userId: string,
  options: { search?: string; favorites?: boolean } = {},
): Promise<BoardSummary[]> {
  const search = options.search?.trim().slice(0, 100) ?? "";
  const result = await getPool().query<BoardRow>(
    `SELECT b.*, u.name AS author_name, (f.user_id IS NOT NULL) AS is_favorite,
       CASE WHEN b.owner_id = $1 THEN 'owner' ELSE m.role END AS role
     FROM boards b JOIN "user" u ON u.id = b.owner_id
     LEFT JOIN board_favorites f ON f.board_id = b.id AND f.user_id = $1
     LEFT JOIN board_members m ON m.board_id = b.id AND m.user_id = $1
       AND m.revoked_at IS NULL AND (m.expires_at IS NULL OR m.expires_at > now())
     LEFT JOIN board_invites i ON i.id = m.invite_id
     WHERE (b.owner_id = $1 OR (m.user_id IS NOT NULL AND (
       m.invite_id IS NULL OR (i.revoked_at IS NULL AND i.expires_at > now())
     ))) AND ($2 = '' OR position(lower($2) in lower(b.title)) > 0)
       AND (NOT $3::boolean OR f.user_id IS NOT NULL)
     ORDER BY b.updated_at DESC LIMIT 200`,
    [userId, search, !!options.favorites],
  );
  return result.rows.map(summarize);
}

export async function getBoardSummary(boardId: string, userId: string): Promise<BoardSummary> {
  const access = await requireBoardAccess(boardId, userId);
  const result = await getPool().query<BoardRow>(
    `SELECT b.*, u.name AS author_name, (f.user_id IS NOT NULL) AS is_favorite,
       $3::text AS role FROM boards b JOIN "user" u ON u.id = b.owner_id
     LEFT JOIN board_favorites f ON f.board_id = b.id AND f.user_id = $2
     WHERE b.id = $1`,
    [boardId, userId, access.role],
  );
  if (!result.rows[0]) throw new HttpError(404, "BOARD_NOT_FOUND", "Доска недоступна.");
  return summarize(result.rows[0]);
}

export async function createBoard(userId: string, title: string): Promise<BoardSummary> {
  const id = randomUUID();
  await getPool().query(
    "INSERT INTO boards(id, owner_id, title) VALUES ($1, $2, $3)",
    [id, userId, title],
  );
  return getBoardSummary(id, userId);
}

export async function renameBoard(boardId: string, userId: string, title: string): Promise<BoardSummary> {
  await requireBoardAccess(boardId, userId, "owner");
  await getPool().query(
    "UPDATE boards SET title = $3, updated_at = now() WHERE id = $1 AND owner_id = $2",
    [boardId, userId, title],
  );
  return getBoardSummary(boardId, userId);
}

export async function deleteBoard(boardId: string, userId: string): Promise<void> {
  await requireBoardAccess(boardId, userId, "owner");
  const keys = await inTransaction(async (client) => {
    await client.query("SELECT id FROM boards WHERE id = $1 FOR UPDATE", [boardId]);
    const assets = await client.query<{ storage_key: string }>(
      "SELECT storage_key FROM assets WHERE board_id = $1", [boardId],
    );
    await client.query("DELETE FROM boards WHERE id = $1 AND owner_id = $2", [boardId, userId]);
    return assets.rows.map((asset) => asset.storage_key);
  });
  const removed = await Promise.allSettled(keys.map(removeStoredAsset));
  if (removed.some((result) => result.status === "rejected")) {
    console.error("Some board assets could not be removed", { boardId });
  }
}

export async function setFavorite(boardId: string, userId: string, favorite: boolean): Promise<void> {
  await requireBoardAccess(boardId, userId);
  if (favorite) {
    await getPool().query(
      "INSERT INTO board_favorites(board_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING",
      [boardId, userId],
    );
  } else {
    await getPool().query("DELETE FROM board_favorites WHERE board_id = $1 AND user_id = $2", [boardId, userId]);
  }
}
