import { createHash, randomBytes, randomUUID } from "node:crypto";

import type { BoardInvite, BoardSummary } from "../types/service";
import { isUuid, requireBoardAccess } from "./access";
import { getBoardSummary } from "./boards";
import { getPool, inTransaction } from "./db";
import { HttpError } from "./http-error";

interface InviteRow {
  id: string;
  board_id: string;
  role: "editor" | "viewer";
  expires_at: Date;
  created_at: Date;
  revoked_at: Date | null;
}

function summarize(row: InviteRow): BoardInvite {
  return {
    id: row.id,
    role: row.role,
    expiresAt: row.expires_at.toISOString(),
    createdAt: row.created_at.toISOString(),
    revokedAt: row.revoked_at?.toISOString() ?? null,
  };
}

export async function createInvite(
  boardId: string,
  userId: string,
  role: unknown,
  expiresInHours: unknown = 168,
): Promise<{ invite: BoardInvite; token: string }> {
  await requireBoardAccess(boardId, userId, "owner");
  if (role !== "editor" && role !== "viewer") {
    throw new HttpError(400, "INVALID_ROLE", "Выберите просмотр или редактирование.");
  }
  if (typeof expiresInHours !== "number" || !Number.isInteger(expiresInHours) ||
      expiresInHours < 1 || expiresInHours > 720) {
    throw new HttpError(400, "INVALID_EXPIRY", "Срок приглашения — от 1 до 720 часов.");
  }
  const token = randomBytes(32).toString("base64url");
  const tokenHash = createHash("sha256").update(token).digest("hex");
  const result = await getPool().query<InviteRow>(
    `INSERT INTO board_invites(id, board_id, token_hash, role, created_by, expires_at)
     VALUES ($1, $2, $3, $4, $5, now() + $6::integer * interval '1 hour') RETURNING *`,
    [randomUUID(), boardId, tokenHash, role, userId, expiresInHours],
  );
  return { invite: summarize(result.rows[0]), token };
}

export async function listInvites(boardId: string, userId: string): Promise<BoardInvite[]> {
  await requireBoardAccess(boardId, userId, "owner");
  const result = await getPool().query<InviteRow>(
    "SELECT * FROM board_invites WHERE board_id = $1 ORDER BY created_at DESC LIMIT 100", [boardId],
  );
  return result.rows.map(summarize);
}

export async function revokeInvite(boardId: string, userId: string, inviteId: string): Promise<void> {
  await requireBoardAccess(boardId, userId, "owner");
  if (!isUuid(inviteId)) throw new HttpError(404, "INVITE_NOT_FOUND", "Приглашение не найдено.");
  const result = await getPool().query(
    "UPDATE board_invites SET revoked_at = COALESCE(revoked_at, now()) WHERE id = $1 AND board_id = $2 RETURNING id",
    [inviteId, boardId],
  );
  if (!result.rows.length) throw new HttpError(404, "INVITE_NOT_FOUND", "Приглашение не найдено.");
}

export async function acceptInvite(
  userId: string,
  token: unknown,
  guestName?: unknown,
  isAnonymous = false,
): Promise<BoardSummary> {
  if (typeof token !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(token)) {
    throw new HttpError(400, "INVALID_INVITE", "Приглашение недействительно.");
  }
  if (guestName !== undefined && (typeof guestName !== "string" || !guestName.trim() ||
      guestName.trim().length > 80 || /[\u0000-\u001f]/.test(guestName))) {
    throw new HttpError(400, "INVALID_NAME", "Имя должно содержать от 1 до 80 символов.");
  }
  const tokenHash = createHash("sha256").update(token).digest("hex");
  const boardId = await inTransaction(async (client) => {
    const result = await client.query<InviteRow & { owner_id: string }>(
      `SELECT i.*, b.owner_id FROM board_invites i JOIN boards b ON b.id = i.board_id
       WHERE i.token_hash = $1 AND i.revoked_at IS NULL AND i.expires_at > now() FOR UPDATE OF i, b`,
      [tokenHash],
    );
    const invite = result.rows[0];
    if (!invite) throw new HttpError(404, "INVALID_INVITE", "Приглашение истекло или отозвано.");
    if (invite.owner_id !== userId) {
      const existing = await client.query<{ invite_id: string | null; revoked_at: Date | null }>(
        "SELECT invite_id, revoked_at FROM board_members WHERE board_id = $1 AND user_id = $2 FOR UPDATE",
        [invite.board_id, userId],
      );
      const sameInvite = existing.rows[0]?.invite_id === invite.id;
      if (sameInvite && existing.rows[0]?.revoked_at) {
        throw new HttpError(403, "ACCESS_REVOKED", "Доступ отозван владельцем.");
      }
      if (!sameInvite) {
        await client.query(
          `INSERT INTO board_members(board_id, user_id, role, invite_id, expires_at)
           VALUES ($1, $2, $3, $4, $5) ON CONFLICT(board_id, user_id) DO UPDATE
           SET role = EXCLUDED.role, invite_id = EXCLUDED.invite_id,
             expires_at = EXCLUDED.expires_at, revoked_at = NULL`,
          [invite.board_id, userId, invite.role, invite.id, invite.expires_at],
        );
      }
    }
    if (isAnonymous && typeof guestName === "string") {
      await client.query('UPDATE "user" SET name = $2, "updatedAt" = now() WHERE id = $1 AND "isAnonymous" = true',
        [userId, guestName.trim()]);
    }
    return invite.board_id;
  });
  return getBoardSummary(boardId, userId);
}
