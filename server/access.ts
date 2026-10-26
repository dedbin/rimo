import type { BoardAccess } from "../types/service";
import { getPool } from "./db";
import { HttpError } from "./http-error";

export function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

export async function getBoardAccess(boardId: string, userId: string): Promise<BoardAccess | null> {
  if (!isUuid(boardId)) return null;
  const result = await getPool().query<{ role: "owner" | "editor" | "viewer" }>(
    `SELECT CASE WHEN b.owner_id = $2 THEN 'owner' ELSE m.role END AS role
     FROM boards b
     LEFT JOIN board_members m ON m.board_id = b.id AND m.user_id = $2
       AND m.revoked_at IS NULL AND (m.expires_at IS NULL OR m.expires_at > now())
     LEFT JOIN board_invites i ON i.id = m.invite_id
     WHERE b.id = $1 AND (b.owner_id = $2 OR (
       m.user_id IS NOT NULL AND (m.invite_id IS NULL OR (
         i.revoked_at IS NULL AND i.expires_at > now()
       ))
     ))`,
    [boardId, userId],
  );
  const row = result.rows[0];
  return row ? { boardId, userId, role: row.role } : null;
}

export async function requireBoardAccess(
  boardId: string,
  userId: string,
  permission: "view" | "edit" | "owner" = "view",
): Promise<BoardAccess> {
  const access = await getBoardAccess(boardId, userId);
  if (!access) throw new HttpError(404, "BOARD_NOT_FOUND", "Доска недоступна.");
  if ((permission === "owner" && access.role !== "owner") ||
      (permission === "edit" && access.role === "viewer")) {
    throw new HttpError(403, "FORBIDDEN", "Недостаточно прав.");
  }
  return access;
}
