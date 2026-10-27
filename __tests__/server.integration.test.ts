// @vitest-environment node

import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";

import { escapeIdentifier, Pool } from "pg";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { GET as listBoardsRoute, POST as createBoardRoute } from "../app/api/boards/route";
import { PATCH as renameBoardRoute } from "../app/api/boards/[boardId]/route";
import { GET as sessionRoute } from "../app/api/boards/[boardId]/session/route";
import { POST as acceptInviteRoute } from "../app/api/invites/accept/route";
import { POST as authRoute } from "../app/api/auth/[...all]/route";
import { HEAD as assetHeadRoute } from "../app/api/assets/[assetId]/route";
import { getBoardAccess } from "../server/access";
import { downloadAsset, uploadAsset } from "../server/assets";
import { getAuth } from "../server/auth";
import { createBoard, deleteBoard, getBoardSummary } from "../server/boards";
import { getPool } from "../server/db";
import { acceptInvite, createInvite, revokeInvite } from "../server/invites";
import { revokeMember, updateMember } from "../server/members";
import { runMigrations } from "../server/migrations";
import type { BoardSummary } from "../types/service";

const databaseUrl = process.env.RIMO_TEST_DATABASE_URL;
const testId = randomUUID();
const password = randomBytes(24).toString("base64url");
const tempRoot = path.resolve(process.cwd(), "temp");
const storagePath = path.join(tempRoot, `server-test-assets-${testId}`);
const userIds: string[] = [];
const boardIds: string[] = [];
let ownerId: string;
let outsiderId: string;
let ownerCookie: string;

function request(url: string, body?: unknown, cookie?: string, method = "POST"): Request {
  return new Request(`http://localhost:3000${url}`, {
    method,
    headers: {
      "content-type": "application/json",
      origin: "http://localhost:3000",
      ...(cookie ? { cookie } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

function cookieFrom(response: Response): string {
  return response.headers.getSetCookie().map((cookie) => cookie.split(";")[0]).join("; ");
}

async function guest(): Promise<{ id: string; cookie: string }> {
  const response = await getAuth().handler(request("/api/auth/sign-in/anonymous", {}));
  expect(response.status).toBe(200);
  const body = await response.json() as { user: { id: string } };
  userIds.push(body.user.id);
  return { id: body.user.id, cookie: cookieFrom(response) };
}

async function board(): Promise<BoardSummary> {
  const result = await createBoard(ownerId, "Учебная доска");
  boardIds.push(result.id);
  return result;
}

describe.skipIf(!databaseUrl)("PostgreSQL auth and board integration", () => {
  beforeAll(async () => {
    process.env.DATABASE_URL = databaseUrl;
    process.env.BETTER_AUTH_SECRET = randomBytes(32).toString("base64url");
    process.env.BETTER_AUTH_URL = "http://localhost:3000";
    process.env.ASSET_STORAGE_PATH = storagePath;
    await mkdir(storagePath, { recursive: true });
    await runMigrations();
    const provisioner = getAuth({ allowSignUp: true });
    const owner = await provisioner.api.signUpEmail({
      body: { name: "Тестовый преподаватель", email: `owner-${testId}@example.test`, password },
    });
    ownerId = owner.user.id;
    userIds.push(ownerId);
    const outsider = await provisioner.api.signUpEmail({
      body: { name: "Другой владелец", email: `other-${testId}@example.test`, password },
    });
    outsiderId = outsider.user.id;
    userIds.push(outsiderId);
    const login = await getAuth().handler(request("/api/auth/sign-in/email", {
      email: `owner-${testId}@example.test`, password,
    }));
    expect(login.status).toBe(200);
    ownerCookie = cookieFrom(login);
  }, 30_000);

  afterAll(async () => {
    for (const boardId of boardIds) await deleteBoard(boardId, ownerId);
    if (userIds.length) {
      await getPool().query('DELETE FROM "user" WHERE id = ANY($1::text[])', [userIds]);
    }
    await getPool().end();
    const resolvedStorage = path.resolve(storagePath);
    if (!resolvedStorage.startsWith(`${tempRoot}${path.sep}`)) throw new Error("Unsafe test cleanup path");
    await rm(resolvedStorage, { recursive: true, force: true });
  });

  it("migrations are repeatable and public owner registration is disabled", async () => {
    expect(await runMigrations()).toEqual([]);
    const response = await getAuth().handler(request("/api/auth/sign-up/email", {
      name: "Unexpected", email: `blocked-${testId}@example.test`, password,
    }));
    expect(response.status).toBe(400);
  });

  describe("migration history preflight on an isolated PostgreSQL schema", () => {
    const schema = `rimo_migration_test_${randomUUID().replaceAll("-", "")}`;
    let admin: Pool | undefined;
    let database: Pool;
    let schemaCreated = false;
    const history = async (): Promise<{ name: string; checksum: string }[]> =>
      (await database.query<{ name: string; checksum: string }>("SELECT name, checksum FROM schema_migrations ORDER BY name")).rows;

    beforeAll(async () => {
      admin = new Pool({ connectionString: databaseUrl, connectionTimeoutMillis: 2_000, statement_timeout: 5_000 });
      await admin.query(`CREATE SCHEMA ${escapeIdentifier(schema)}`);
      schemaCreated = true;
      const isolated = new URL(databaseUrl!);
      isolated.searchParams.set("options", `-c search_path=${schema}`);
      database = new Pool({ connectionString: isolated.toString(), max: 2, connectionTimeoutMillis: 2_000, statement_timeout: 5_000 });
      const current = await database.query<{ schema: string }>("SELECT current_schema() AS schema");
      expect(current.rows[0].schema).toBe(schema);
      await runMigrations(database);
    });

    afterAll(async () => {
      try { await database?.end(); }
      finally {
        try {
          if (schemaCreated) {
            if (!/^rimo_migration_test_[a-f0-9]{32}$/.test(schema)) throw new Error("Unsafe migration test schema");
            await admin!.query(`DROP SCHEMA ${escapeIdentifier(schema)} CASCADE`);
          }
        } finally { await admin?.end(); }
      }
    });

    it("rejects a newer database history, preserves it and succeeds after removing only its own future row", async () => {
      const before = await history();
      const future = { name: `999999-test-future-${randomUUID()}.sql`, checksum: "0".repeat(64) };
      await database.query("INSERT INTO schema_migrations(name,checksum) VALUES($1,$2)", [future.name, future.checksum]);
      try {
        await expect(runMigrations(database)).rejects.toThrow(`Applied migration is missing from this image: ${future.name}`);
        const rejected = await history();
        expect(rejected.filter((entry) => entry.name !== future.name)).toEqual(before);
        expect(rejected.find((entry) => entry.name === future.name)).toEqual(future);
      } finally {
        await database.query("DELETE FROM schema_migrations WHERE name=$1 AND checksum=$2", [future.name, future.checksum]);
      }
      expect(await history()).toEqual(before);
      expect(await runMigrations(database)).toEqual([]);
    });

    it("rejects an altered historical checksum without rewriting it and succeeds after exact restoration", async () => {
      const before = await history();
      expect(before.length).toBeGreaterThan(0);
      const original = before[0];
      const changed = original.checksum === "0".repeat(64) ? "1".repeat(64) : "0".repeat(64);
      await database.query("UPDATE schema_migrations SET checksum=$2 WHERE name=$1", [original.name, changed]);
      try {
        await expect(runMigrations(database)).rejects.toThrow(`Migration checksum differs: ${original.name}`);
        expect(await history()).toEqual(before.map((entry) => entry.name === original.name ? { ...entry, checksum: changed } : entry));
      } finally {
        await database.query("UPDATE schema_migrations SET checksum=$2 WHERE name=$1 AND checksum=$3", [original.name, original.checksum, changed]);
      }
      expect(await history()).toEqual(before);
      expect(await runMigrations(database)).toEqual([]);
    });
  });

  it("requires a real session and rejects cross-site mutation", async () => {
    expect((await listBoardsRoute(request("/api/boards", undefined, undefined, "GET"))).status).toBe(401);
    const response = await createBoardRoute(new Request("http://localhost:3000/api/boards", {
      method: "POST", headers: { origin: "https://untrusted.example", cookie: ownerCookie },
      body: JSON.stringify({ title: "Forbidden" }),
    }));
    expect(response.status).toBe(403);
  });

  it("creates owner boards through HTTP and hides them from strangers", async () => {
    const response = await createBoardRoute(request("/api/boards", { title: "  Геометрия  " }, ownerCookie));
    expect(response.status).toBe(201);
    const body = await response.json() as { board: BoardSummary };
    boardIds.push(body.board.id);
    expect(body.board.title).toBe("Геометрия");
    expect(body.board.role).toBe("owner");
    expect(await getBoardAccess(body.board.id, outsiderId)).toBeNull();
    await expect(getBoardSummary(body.board.id, outsiderId)).rejects.toMatchObject({ status: 404 });
    expect(await getBoardAccess("not-a-uuid", ownerId)).toBeNull();
  });

  it("grants guests only the invited board and stores only token hashes", async () => {
    const first = await board();
    const second = await board();
    const invitedGuest = await guest();
    const created = await createInvite(first.id, ownerId, "editor", 24);
    const stored = await getPool().query<{ token_hash: string }>(
      "SELECT token_hash FROM board_invites WHERE id = $1", [created.invite.id],
    );
    expect(stored.rows[0].token_hash).toHaveLength(64);
    expect(stored.rows[0].token_hash).not.toBe(created.token);
    const accepted = await acceptInviteRoute(request("/api/invites/accept", {
      token: created.token, name: "Ученик",
    }, invitedGuest.cookie));
    expect(accepted.status).toBe(200);
    expect((await getBoardAccess(first.id, invitedGuest.id))?.role).toBe("editor");
    expect(await getBoardAccess(second.id, invitedGuest.id)).toBeNull();
    const context = { params: Promise.resolve({ boardId: first.id }) };
    const session = await sessionRoute(request("/api/boards/session", undefined, invitedGuest.cookie, "GET"), context);
    const sessionBody = await session.json() as { user: { name: string }; role: string; connection: { token: string } };
    expect(sessionBody.user.name).toBe("Ученик");
    expect(sessionBody.role).toBe("editor");
    expect(sessionBody.connection.token).toBe("cookie");
    expect((await createBoardRoute(request("/api/boards", { title: "No" }, invitedGuest.cookie))).status).toBe(403);
    expect((await renameBoardRoute(request("/api/boards", { title: "No" }, invitedGuest.cookie, "PATCH"), context)).status).toBe(403);
  });

  it("keeps downgraded and revoked memberships when the same invite is accepted again", async () => {
    const target = await board();
    const invitedGuest = await guest();
    const created = await createInvite(target.id, ownerId, "editor");
    await acceptInvite(invitedGuest.id, created.token);
    await updateMember(target.id, ownerId, invitedGuest.id, "viewer");
    await acceptInvite(invitedGuest.id, created.token);
    expect((await getBoardAccess(target.id, invitedGuest.id))?.role).toBe("viewer");
    await expect(uploadAsset(target.id, invitedGuest.id, Buffer.from("invalid"))).rejects.toMatchObject({ status: 403 });
    await revokeMember(target.id, ownerId, invitedGuest.id);
    await expect(acceptInvite(invitedGuest.id, created.token)).rejects.toMatchObject({ status: 403 });
    expect(await getBoardAccess(target.id, invitedGuest.id)).toBeNull();
  });

  it("rejects revoked and expired invitations including existing grants", async () => {
    const target = await board();
    const invitedGuest = await guest();
    const created = await createInvite(target.id, ownerId, "editor");
    await acceptInvite(invitedGuest.id, created.token);
    await revokeInvite(target.id, ownerId, created.invite.id);
    expect(await getBoardAccess(target.id, invitedGuest.id)).toBeNull();
    await expect(acceptInvite(invitedGuest.id, created.token)).rejects.toMatchObject({ status: 404 });
    const expiring = await createInvite(target.id, ownerId, "viewer");
    await acceptInvite(invitedGuest.id, expiring.token);
    await getPool().query("UPDATE board_invites SET expires_at = now() - interval '1 minute' WHERE id = $1", [expiring.invite.id]);
    expect(await getBoardAccess(target.id, invitedGuest.id)).toBeNull();
  });

  it("decodes uploads, deduplicates within a board and enforces asset ACL", async () => {
    const target = await board();
    const png = await sharp({ create: { width: 3, height: 2, channels: 4, background: "red" } }).png().toBuffer();
    const first = await uploadAsset(target.id, ownerId, png);
    const second = await uploadAsset(target.id, ownerId, png);
    expect(first.id).toBe(second.id);
    expect(first).toMatchObject({ width: 3, height: 2, mimeType: "image/webp" });
    expect(first.url).toBe(`/api/assets/${first.id}`);
    const downloaded = await downloadAsset(first.id, ownerId);
    expect(downloaded.headers.get("content-type")).toBe("image/webp");
    expect((await downloaded.arrayBuffer()).byteLength).toBe(first.size);
    const headContext = { params: Promise.resolve({ assetId: first.id }) };
    const head = await assetHeadRoute(request(first.url, undefined, ownerCookie, "HEAD"), headContext);
    expect(head.status).toBe(200);
    expect(head.body).toBeNull();
    expect(head.headers.get("content-length")).toBe(String(first.size));
    expect(head.headers.get("content-type")).toBe("image/webp");
    expect((await assetHeadRoute(request(first.url, undefined, undefined, "HEAD"), headContext)).status).toBe(401);
    await expect(downloadAsset(first.id, outsiderId)).rejects.toMatchObject({ status: 404 });
    await expect(downloadAsset(first.id, outsiderId, { head: true })).rejects.toMatchObject({ status: 404 });
    await expect(uploadAsset(target.id, ownerId, Buffer.from('<svg onload="alert(1)"></svg>')))
      .rejects.toMatchObject({ status: 400 });
  });

  it("bounds JSON requests even without a content-length header", async () => {
    const response = await createBoardRoute(request("/api/boards", { title: "x".repeat(20_000) }, ownerCookie));
    expect(response.status).toBe(413);
  });

  it("validates profile updates through Better Auth and bounds its public route", async () => {
    const update = await getAuth().handler(request("/api/auth/update-user", {
      name: "x".repeat(4096), image: "file:///invalid-profile-image",
    }, ownerCookie));
    expect(update.status).toBe(400);
    const profile = await getPool().query<{ name: string }>('SELECT name FROM "user" WHERE id = $1', [ownerId]);
    expect(profile.rows[0].name).toBe("Тестовый преподаватель");
    const oversized = await authRoute(request("/api/auth/update-user", {
      name: "x".repeat(20_000),
    }, ownerCookie));
    expect(oversized.status).toBe(413);
  });
});
