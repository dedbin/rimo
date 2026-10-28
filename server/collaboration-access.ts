import type { BoardRole } from "../types/service";

import { isUuid } from "./access";
import { getPool } from "./db";

export async function getCollaborationRole(
  sessionId: string,
  userId: string,
  boardId: string,
): Promise<BoardRole | null> {
  if (!isUuid(boardId)) return null;
  // Keep the session and board ACL predicates in one current database snapshot.
  const result = await getPool().query<{ role: BoardRole }>(
    `SELECT CASE WHEN b.owner_id = $2 THEN 'owner' ELSE m.role END AS role
     FROM session s
     JOIN "user" u ON u.id = s."userId"
     JOIN boards b ON b.id = $3
     LEFT JOIN board_members m ON m.board_id = b.id AND m.user_id = $2
       AND m.revoked_at IS NULL AND (m.expires_at IS NULL OR m.expires_at > now())
     LEFT JOIN board_invites i ON i.id = m.invite_id
     WHERE s.id = $1 AND s."userId" = $2 AND s."expiresAt" > now()
       AND (u."isAnonymous" = true OR (u."emailVerified" = true AND u."registrationPending" = false))
       AND (b.owner_id = $2 OR (
         m.user_id IS NOT NULL AND (m.invite_id IS NULL OR (
           i.revoked_at IS NULL AND i.expires_at > now()
         ))
       ))`,
    [sessionId, userId, boardId],
  );
  return result.rows[0]?.role ?? null;
}
