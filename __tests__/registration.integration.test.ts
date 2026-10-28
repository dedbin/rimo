// @vitest-environment node

import { randomBytes, randomUUID } from "node:crypto";

import { createAuthClient } from "better-auth/client";
import { escapeIdentifier, Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { GET as authGet, POST as authPost } from "../app/api/auth/[...all]/route";
import { GET as getBoard } from "../app/api/boards/[boardId]/route";
import { GET as listBoards, POST as createBoard } from "../app/api/boards/route";
import { getPool } from "../server/db";
import { runMigrations } from "../server/migrations";

const databaseUrl = process.env.RIMO_TEST_DATABASE_URL;
const schema = `rimo_registration_test_${randomUUID().replaceAll("-", "")}`;
const quotedSchema = escapeIdentifier(schema);
const origin = "http://localhost:3000";
const password = randomBytes(24).toString("base64url");
let admin: Pool;
let clientSequence = 0;

function request(path: string, body?: unknown, cookie?: string, requestOrigin = origin, clientIp = `198.51.100.${++clientSequence}`): Request {
  return new Request(`${origin}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { "Content-Type": "application/json", Origin: requestOrigin, "X-Forwarded-For": clientIp, ...(cookie ? { Cookie: cookie } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

function input(): { name: string; email: string; password: string } {
  return { name: "Новый преподаватель", email: `${randomUUID()}@example.test`, password };
}

function cookie(response: Response): string {
  return response.headers.getSetCookie().map((value) => value.split(";")[0]).join("; ");
}

async function seed(anonymous = false): Promise<string> {
  const id = randomUUID();
  await getPool().query('INSERT INTO "user"(id, name, email, "isAnonymous") VALUES ($1,$2,$3,$4)',
    [id, "Существующий владелец", `${id}@example.test`, anonymous]);
  return id;
}

async function owners(): Promise<number> {
  const result = await getPool().query<{ total: string }>('SELECT count(*) AS total FROM "user" WHERE "isAnonymous" = false');
  return Number(result.rows[0].total);
}

describe.skipIf(!databaseUrl)("public registration through the real auth route", () => {
  beforeAll(async () => {
    admin = new Pool({ connectionString: databaseUrl });
    await admin.query(`CREATE SCHEMA ${quotedSchema}`);
    const isolated = new URL(databaseUrl!);
    isolated.searchParams.set("options", `-c search_path=${schema}`);
    vi.stubEnv("DATABASE_URL", isolated.toString());
    vi.stubEnv("BETTER_AUTH_SECRET", randomBytes(32).toString("base64url"));
    vi.stubEnv("BETTER_AUTH_URL", origin);
    vi.stubEnv("MAX_OWNERS", "6");
    const current = await getPool().query<{ schema: string }>("SELECT current_schema() AS schema");
    if (current.rows[0].schema !== schema) throw new Error("Registration tests require their own schema");
    await runMigrations();
  }, 30_000);

  beforeEach(async () => {
    await getPool().query(`TRUNCATE ${quotedSchema}.boards, ${quotedSchema}."user" CASCADE`);
  });

  afterAll(async () => {
    await getPool().end();
    if (!/^rimo_registration_test_[a-f0-9]{32}$/.test(schema)) throw new Error("Unsafe registration cleanup");
    await admin.query(`DROP SCHEMA ${quotedSchema} CASCADE`);
    await admin.end();
    vi.unstubAllEnvs();
  });

  it("creates a persistent owner session, permits login and isolates existing boards", async () => {
    const existing = await seed();
    const foreignBoard = randomUUID();
    await getPool().query("INSERT INTO boards(id, owner_id, title) VALUES ($1,$2,$3)", [foreignBoard, existing, "Чужая доска"]);
    const credentials = input();
    const registration = await authPost(request("/api/auth/sign-up/email", credentials));
    expect(registration.status).toBe(200);
    const account = await registration.json() as { user: { id: string; isAnonymous: boolean } };
    expect(account.user.isAnonymous).toBe(false);
    const sessionCookie = cookie(registration);
    expect(sessionCookie).not.toBe("");
    const session = await authGet(request("/api/auth/get-session", undefined, sessionCookie));
    expect((await session.json()).user.id).toBe(account.user.id);
    const boards = await listBoards(request("/api/boards", undefined, sessionCookie));
    expect(await boards.json()).toEqual({ boards: [] });
    const foreign = await getBoard(request(`/api/boards/${foreignBoard}`, undefined, sessionCookie), {
      params: Promise.resolve({ boardId: foreignBoard }),
    });
    expect(foreign.status).toBe(404);
    const own = await createBoard(request("/api/boards", { title: "Моя доска" }, sessionCookie));
    expect(own.status).toBe(201);
    expect((await own.json()).board.ownerId).toBe(account.user.id);
    const login = await authPost(request("/api/auth/sign-in/email", { email: credentials.email, password }));
    expect(login.status).toBe(200);
    expect((await login.json()).user.id).toBe(account.user.id);
  });

  it("keeps password, email and profile validation, duplicate protection and origin checks", async () => {
    const credentials = input();
    for (const body of [
      { ...credentials, password: "short" },
      { ...credentials, email: "not-an-email" },
      { ...credentials, name: " " },
      { ...credentials, image: "javascript:alert(1)" },
    ]) {
      const response = await authPost(request("/api/auth/sign-up/email", body));
      expect(response.status).toBeGreaterThanOrEqual(400);
      expect(response.status).toBeLessThan(500);
    }
    const crossSite = await authPost(request("/api/auth/sign-up/email", credentials, undefined, "https://other.example.test"));
    expect(crossSite.status).toBe(403);
    expect(await owners()).toBe(0);
    expect((await authPost(request("/api/auth/sign-up/email", credentials))).status).toBe(200);
    const duplicate = await authPost(request("/api/auth/sign-up/email", credentials));
    expect(duplicate.status).toBe(422);
    expect(await owners()).toBe(1);
    const repeatedClientStatuses: number[] = [];
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const repeated = await authPost(request("/api/auth/sign-up/email", { ...input(), password: "short" }, undefined, origin, "198.51.100.250"));
      repeatedClientStatuses.push(repeated.status);
    }
    expect(repeatedClientStatuses).toEqual([400, 400, 400, 429]);
    expect(await owners()).toBe(1);
  });

  it("excludes guests, serializes the last owner slot and returns SDK-readable quota errors", async () => {
    for (let index = 0; index < 5; index += 1) await seed();
    for (let index = 0; index < 8; index += 1) await seed(true);
    const responses = await Promise.all([0, 1].map(() => authPost(request("/api/auth/sign-up/email", input()))));
    expect(responses.map((response) => response.status).sort()).toEqual([200, 409]);
    const rejected = responses.find((response) => response.status === 409)!;
    expect(await rejected.json()).toMatchObject({ code: "OWNER_LIMIT_REACHED" });
    expect(await owners()).toBe(6);
    const client = createAuthClient({ baseURL: origin, fetchOptions: {
      customFetchImpl: async (url, init) => {
        const outgoing = new Request(url, init);
        outgoing.headers.set("Origin", origin);
        return authPost(outgoing);
      },
    } });
    const result = await client.signUp.email(input());
    expect(result.error).toMatchObject({ code: "OWNER_LIMIT_REACHED", status: 409 });
  });

  it("does not let alternate signup paths bypass quota and leaves anonymous sign-in available", async () => {
    for (let index = 0; index < 6; index += 1) await seed();
    const trailing = await authPost(request("/api/auth/sign-up/email/", input()));
    expect(trailing.status).toBe(409);
    for (const path of ["/api/auth/sign-up/%65mail", "/api/auth/sign-up//email"]) {
      const alternate = await authPost(request(path, input()));
      expect(alternate.status).toBeGreaterThanOrEqual(400);
    }
    const guest = await authPost(request("/api/auth/sign-in/anonymous", {}));
    expect(guest.status).toBe(200);
    expect((await guest.json()).user.isAnonymous).toBe(true);
    expect(await owners()).toBe(6);
  });
});
