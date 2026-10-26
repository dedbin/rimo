import type { AuthSession } from "./auth";
import { getAuth } from "./auth";
import { getPool } from "./db";
import { HttpError } from "./http-error";

export async function requireSession(request: Request): Promise<AuthSession> {
  const session = await getAuth().api.getSession({
    headers: request.headers,
    query: { disableCookieCache: true },
  });
  if (!session) throw new HttpError(401, "UNAUTHORIZED", "Войдите в аккаунт.");
  return session;
}

export async function requireOwnerSession(request: Request): Promise<AuthSession> {
  const session = await requireSession(request);
  if (session.user.isAnonymous) {
    throw new HttpError(403, "OWNER_REQUIRED", "Действие доступно владельцу аккаунта.");
  }
  return session;
}

export async function getSessionById(
  sessionId: string,
  userId: string,
): Promise<{ id: string; userId: string; expiresAt: Date } | null> {
  const result = await getPool().query<{
    id: string;
    userId: string;
    expiresAt: Date;
  }>(
    `SELECT id, "userId", "expiresAt" FROM session
     WHERE id = $1 AND "userId" = $2 AND "expiresAt" > now()`,
    [sessionId, userId],
  );
  return result.rows[0] ?? null;
}
