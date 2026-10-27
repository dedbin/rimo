import { getBoardAccess } from "../server/access";
import { getAuth } from "../server/auth";
import { getCollaborationRole } from "../server/collaboration-access";
import { getPool } from "../server/db";

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
      return getCollaborationRole(principal.sessionId, principal.userId, principal.boardId);
    },
  };
}
