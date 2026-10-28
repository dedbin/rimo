import { requireBoardAccess } from "./access";
import { getPool } from "./db";
import { HttpError } from "./http-error";

export interface BoardMember {
  userId: string;
  name: string;
  role: "editor" | "viewer";
  expiresAt: string | null;
  revokedAt: string | null;
}

export async function listMembers(boardId: string, userId: string): Promise<BoardMember[]> {
  await requireBoardAccess(boardId, userId, "owner");
  const result = await getPool().query<{
    user_id: string; name: string; role: "editor" | "viewer";
    expires_at: Date | null; revoked_at: Date | null;
  }>(
    `SELECT m.user_id, u.name, m.role, m.expires_at, m.revoked_at
     FROM board_members m JOIN "user" u ON u.id = m.user_id
     WHERE m.board_id = $1 ORDER BY m.created_at`, [boardId],
  );
  return result.rows.map((row) => ({
    userId: row.user_id, name: row.name, role: row.role,
    expiresAt: row.expires_at?.toISOString() ?? null,
    revokedAt: row.revoked_at?.toISOString() ?? null,
  }));
}

export async function updateMember(
  boardId: string, userId: string, memberId: string, role: unknown,
): Promise<void> {
  await requireBoardAccess(boardId, userId, "owner");
  if (role !== "editor" && role !== "viewer") {
    throw new HttpError(400, "INVALID_ROLE", "Выберите просмотр или редактирование.");
  }
  const result = await getPool().query(
    "UPDATE board_members SET role = $3 WHERE board_id = $1 AND user_id = $2 AND revoked_at IS NULL RETURNING user_id",
    [boardId, memberId, role],
  );
  if (!result.rows.length) throw new HttpError(404, "MEMBER_NOT_FOUND", "Участник не найден.");
}

export async function revokeMember(boardId: string, userId: string, memberId: string): Promise<void> {
  await requireBoardAccess(boardId, userId, "owner");
  const result = await getPool().query(
    "UPDATE board_members SET revoked_at = COALESCE(revoked_at, now()) WHERE board_id = $1 AND user_id = $2 RETURNING user_id",
    [boardId, memberId],
  );
  if (!result.rows.length) throw new HttpError(404, "MEMBER_NOT_FOUND", "Участник не найден.");
}
