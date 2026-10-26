import { getBoardAccess } from "../server/access";
import { getAuth } from "../server/auth";
import { getPool } from "../server/db";
import { getSessionById } from "../server/session";

import { createPostgresRepository } from "./postgres-repository";
import type { CollaborationDependencies } from "./types";

export function createCollaborationDependencies(): CollaborationDependencies {
  return {
    repository: createPostgresRepository(getPool()),
    async authenticate(headers, boardId) {
      const session = await getAuth().api.getSession({ headers, query: { disableCookieCache: true } });
      if (!session) return null;
      const access = await getBoardAccess(boardId, session.user.id);
      if (!access) return null;
      return {
        boardId,
        userId: session.user.id,
        sessionId: session.session.id,
        name: session.user.name,
        ...(session.user.image ? { image: session.user.image } : {}),
        role: access.role,
      };
    },
    async revalidate(principal) {
      const session = await getSessionById(principal.sessionId, principal.userId);
      if (!session) return null;
      const access = await getBoardAccess(principal.boardId, principal.userId);
      return access?.role ?? null;
    },
  };
}
