// @vitest-environment node

import { randomUUID } from "node:crypto";

import { escapeIdentifier, Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { getBoardAccess } from "../server/access";
import { getCollaborationRole } from "../server/collaboration-access";
import { runMigrations } from "../server/migrations";
import { getSessionById } from "../server/session";
import type { BoardRole } from "../types/service";

const databaseUrl = process.env.RIMO_TEST_DATABASE_URL;
const schema = `rimo_collaboration_acl_${randomUUID().replaceAll("-", "")}`;
let admin: Pool | undefined;
let database: Pool;
let schemaCreated = false;
vi.mock("../server/db", () => ({ getPool: () => database }));

type Actor = "owner" | "member" | "outsider";
interface Fixture {
  boardId: string;
  inviteId: string;
  users: Record<Actor, string>;
  sessions: Record<Actor, string>;
}
interface Scenario {
  name: string;
  actor?: Actor;
  expected: BoardRole | null;
  prepare?: (data: Fixture) => Promise<unknown>;
}
let fixture: Fixture;

async function expectEquivalent(actor: Actor, expected: BoardRole | null, boardId = fixture.boardId): Promise<void> {
  const userId = fixture.users[actor];
  const sessionId = fixture.sessions[actor];
  const session = await getSessionById(sessionId, userId);
  const previous = session ? (await getBoardAccess(boardId, userId))?.role ?? null : null;
  expect(previous).toBe(expected);
  expect(await getCollaborationRole(sessionId, userId, boardId)).toBe(previous);
}

const scenarios: Scenario[] = [
  { name: "board owner", actor: "owner", expected: "owner" },
  { name: "invited editor uses membership role, not invitation role", expected: "editor" },
  { name: "invited viewer", expected: "viewer", prepare: f => database.query(
    "UPDATE board_members SET role='viewer' WHERE board_id=$1 AND user_id=$2", [f.boardId, f.users.member],
  ) },
  { name: "direct member without expiration", expected: "editor", prepare: f => database.query(
    "UPDATE board_members SET invite_id=NULL, expires_at=NULL WHERE board_id=$1 AND user_id=$2", [f.boardId, f.users.member],
  ) },
  { name: "unlinked revoked invitation does not revoke a direct member", expected: "editor", prepare: async f => {
    await database.query("UPDATE board_members SET invite_id=NULL WHERE board_id=$1 AND user_id=$2", [f.boardId, f.users.member]);
    await database.query("UPDATE board_invites SET revoked_at=now() WHERE id=$1", [f.inviteId]);
  } },
  { name: "linked membership without its own expiration", expected: "editor", prepare: f => database.query(
    "UPDATE board_members SET expires_at=NULL WHERE board_id=$1 AND user_id=$2", [f.boardId, f.users.member],
  ) },
  { name: "direct member with future expiration", expected: "editor", prepare: f => database.query(
    "UPDATE board_members SET invite_id=NULL WHERE board_id=$1 AND user_id=$2", [f.boardId, f.users.member],
  ) },
  { name: "anonymous member session", expected: "editor", prepare: f => database.query(
    'UPDATE "user" SET "isAnonymous"=true WHERE id=$1', [f.users.member],
  ) },
  { name: "anonymous session without membership", actor: "outsider", expected: null, prepare: f => database.query(
    'UPDATE "user" SET "isAnonymous"=true WHERE id=$1', [f.users.outsider],
  ) },
  { name: "authenticated non-member", actor: "outsider", expected: null },
  { name: "missing session", expected: null, prepare: f => database.query(
    "DELETE FROM session WHERE id=$1", [f.sessions.member],
  ) },
  { name: "session bound to another user", expected: null, prepare: f => database.query(
    'UPDATE session SET "userId"=$2 WHERE id=$1', [f.sessions.member, f.users.outsider],
  ) },
  { name: "expired session", expected: null, prepare: f => database.query(
    'UPDATE session SET "expiresAt"=now()-interval \'1 second\' WHERE id=$1', [f.sessions.member],
  ) },
  { name: "expired owner session", actor: "owner", expected: null, prepare: f => database.query(
    'UPDATE session SET "expiresAt"=now()-interval \'1 second\' WHERE id=$1', [f.sessions.owner],
  ) },
  { name: "revoked membership", expected: null, prepare: f => database.query(
    "UPDATE board_members SET revoked_at=now() WHERE board_id=$1 AND user_id=$2", [f.boardId, f.users.member],
  ) },
  { name: "expired membership", expected: null, prepare: f => database.query(
    "UPDATE board_members SET expires_at=now()-interval '1 second' WHERE board_id=$1 AND user_id=$2", [f.boardId, f.users.member],
  ) },
  { name: "revoked invitation", expected: null, prepare: f => database.query(
    "UPDATE board_invites SET revoked_at=now() WHERE id=$1", [f.inviteId],
  ) },
  { name: "expired invitation", expected: null, prepare: f => database.query(
    "UPDATE board_invites SET expires_at=now()-interval '1 second' WHERE id=$1", [f.inviteId],
  ) },
  { name: "deleted board", expected: null, prepare: f => database.query("DELETE FROM boards WHERE id=$1", [f.boardId]) },
  { name: "deleted session user", expected: null, prepare: f => database.query('DELETE FROM "user" WHERE id=$1', [f.users.member]) },
  { name: "owner overrides revoked expired membership and invitation", actor: "owner", expected: "owner", prepare: async f => {
    await database.query("UPDATE board_invites SET revoked_at=now(), expires_at=now()-interval '1 second' WHERE id=$1", [f.inviteId]);
    await database.query(
      `INSERT INTO board_members(board_id,user_id,role,invite_id,expires_at,revoked_at)
       VALUES($1,$2,'viewer',$3,now()-interval '1 second',now())`, [f.boardId, f.users.owner, f.inviteId],
    );
  } },
];

describe.skipIf(!databaseUrl)("PostgreSQL single-query collaboration ACL parity", () => {
  beforeAll(async () => {
    admin = new Pool({ connectionString: databaseUrl, max: 1, connectionTimeoutMillis: 2_000, statement_timeout: 5_000 });
    await admin.query(`CREATE SCHEMA ${escapeIdentifier(schema)}`);
    schemaCreated = true;
    const isolatedUrl = new URL(databaseUrl!);
    isolatedUrl.searchParams.set("options", `-c search_path=${schema}`);
    // A single connection also lets boundary tests pin now() inside their own transaction.
    database = new Pool({ connectionString: isolatedUrl.toString(), max: 1, connectionTimeoutMillis: 2_000, statement_timeout: 5_000 });
    const current = await database.query<{ schema: string }>("SELECT current_schema() AS schema");
    if (current.rows[0].schema !== schema) throw new Error("Collaboration ACL tests require their isolated schema");
    await runMigrations(database);
  }, 20_000);

  beforeEach(async () => {
    await database.query(`TRUNCATE ${escapeIdentifier(schema)}.boards, ${escapeIdentifier(schema)}."user" CASCADE`);
    fixture = {
      boardId: randomUUID(), inviteId: randomUUID(),
      users: { owner: randomUUID(), member: randomUUID(), outsider: randomUUID() },
      sessions: { owner: randomUUID(), member: randomUUID(), outsider: randomUUID() },
    };
    await database.query(
      `INSERT INTO "user"(id,name,email)
       SELECT id,'ACL parity',id||'@example.test' FROM unnest($1::text[]) AS users(id)`, [Object.values(fixture.users)],
    );
    await database.query(
      `INSERT INTO session(id,token,"userId","expiresAt")
       SELECT id,token,user_id,now()+interval '1 day' FROM unnest($1::text[],$2::text[],$3::text[]) AS sessions(id,token,user_id)`,
      [Object.values(fixture.sessions), [randomUUID(), randomUUID(), randomUUID()], Object.values(fixture.users)],
    );
    await database.query("INSERT INTO boards(id,owner_id,title) VALUES($1,$2,'ACL parity')", [fixture.boardId, fixture.users.owner]);
    await database.query(
      `INSERT INTO board_invites(id,board_id,token_hash,role,created_by,expires_at)
       VALUES($1,$2,$3,'viewer',$4,now()+interval '1 day')`,
      [fixture.inviteId, fixture.boardId, randomUUID().replaceAll("-", "").repeat(2), fixture.users.owner],
    );
    await database.query(
      `INSERT INTO board_members(board_id,user_id,role,invite_id,expires_at)
       VALUES($1,$2,'editor',$3,now()+interval '1 day')`, [fixture.boardId, fixture.users.member, fixture.inviteId],
    );
  });

  afterAll(async () => {
    try { await database?.end(); }
    finally {
      try {
        if (schemaCreated) {
          if (!/^rimo_collaboration_acl_[a-f0-9]{32}$/.test(schema)) throw new Error("Unexpected collaboration ACL test schema");
          await admin!.query(`DROP SCHEMA ${escapeIdentifier(schema)} CASCADE`);
        }
      } finally { await admin?.end(); }
    }
  });

  it.each(scenarios)("matches session + board ACL for $name", async ({ actor = "member", expected, prepare }) => {
    await prepare?.(fixture);
    await expectEquivalent(actor, expected);
  });

  it.each(["session", "member", "invite"] as const)("rejects %s expiration exactly at database now()", async (kind) => {
    const statements = {
      session: ['UPDATE session SET "expiresAt"=now() WHERE id=$1', fixture.sessions.member],
      member: ["UPDATE board_members SET expires_at=now() WHERE board_id=$1", fixture.boardId],
      invite: ["UPDATE board_invites SET expires_at=now() WHERE id=$1", fixture.inviteId],
    } as const;
    await database.query("BEGIN");
    try {
      const [sql, id] = statements[kind];
      await database.query(sql, [id]);
      await expectEquivalent("member", null);
    } finally { await database.query("ROLLBACK"); }
  });

  it("observes promotion, demotion and invitation revocation on every fresh call", async () => {
    await expectEquivalent("member", "editor");
    await database.query("UPDATE board_members SET role='viewer' WHERE board_id=$1", [fixture.boardId]);
    await expectEquivalent("member", "viewer");
    await database.query("UPDATE board_members SET role='editor' WHERE board_id=$1", [fixture.boardId]);
    await expectEquivalent("member", "editor");
    await database.query("UPDATE board_invites SET revoked_at=now() WHERE id=$1", [fixture.inviteId]);
    await expectEquivalent("member", null);
    await database.query("UPDATE board_invites SET revoked_at=NULL WHERE id=$1", [fixture.inviteId]);
    await expectEquivalent("member", "editor");
    await database.query("DELETE FROM session WHERE id=$1", [fixture.sessions.member]);
    await expectEquivalent("member", null);
  });

  it("reads the current board owner and rejects missing or invalid board IDs", async () => {
    await database.query("UPDATE boards SET owner_id=$2 WHERE id=$1", [fixture.boardId, fixture.users.outsider]);
    await expectEquivalent("owner", null);
    await expectEquivalent("outsider", "owner");
    await expectEquivalent("owner", null, randomUUID());
    await expectEquivalent("member", null, "not-a-uuid");
    await expectEquivalent("member", "editor", fixture.boardId.toUpperCase());
  });
});
