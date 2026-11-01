// @vitest-environment node

import { randomBytes, randomUUID } from "node:crypto";

import { verifyPassword } from "better-auth/crypto";
import type { PoolClient } from "pg";
import { describe, expect, it } from "vitest";

import { beginOwnerRecovery } from "../server/owner-recovery";
import {
  authGet, authPost, cookie, deliveredCode, getPool, login, password, register, request, sendCode,
  testDatabaseUrl, useVerificationDatabase, verifyCode,
} from "./email-verification-fixtures";

async function owner() {
  const account = await register();
  expect((await sendCode(account.email)).status).toBe(200);
  expect((await verifyCode(account.email, deliveredCode(account.email))).status).toBe(200);
  return account;
}

async function recovery(email: string) {
  let code = "";
  const challenge = await beginOwnerRecovery(email, {
    database: getPool(), sendCode: async (recipient, value) => { expect(recipient).toBe(email); code = value; },
  });
  challenge.verify(code);
  return challenge;
}

async function passwordHash(userId: string): Promise<string> {
  const result = await getPool().query<{ password: string }>(
    'SELECT password FROM account WHERE "userId"=$1 AND "providerId"=\'credential\'', [userId],
  );
  return result.rows[0].password;
}

async function sessionCount(userId: string): Promise<number> {
  return (await getPool().query<{ total: number }>('SELECT count(*)::int AS total FROM session WHERE "userId"=$1', [userId])).rows[0].total;
}

async function lockedElsewhere(client: PoolClient, key: string): Promise<boolean> {
  // Observe without temporarily acquiring the lock: a try-lock probe can make
  // the recovery's own try-lock fail and would introduce a fixture-only race.
  const result = await client.query<{ held: boolean }>(
    `SELECT EXISTS(SELECT 1 FROM pg_locks WHERE locktype='advisory' AND granted
      AND pid<>pg_backend_pid() AND objsubid=2
      AND classid::bigint=(hashtext(current_database() || ':' || current_schema())::bigint & 4294967295)
      AND objid::bigint=(hashtext($1)::bigint & 4294967295)) AS held`, [key],
  );
  return result.rows[0].held;
}

async function waitUntil(predicate: () => Promise<boolean>): Promise<void> {
  const end = Date.now() + 5_000;
  while (!await predicate()) {
    if (Date.now() >= end) throw new Error("Recovery lock fixture timed out");
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

describe.skipIf(!testDatabaseUrl)("operator recovery through PostgreSQL and Better Auth", () => {
  useVerificationDatabase("rimo_owner_recovery");

  it("replaces only the credential, revokes every session and preserves flags, boards and rights", async () => {
    const account = await owner();
    const firstLogin = await login(account.email);
    expect(firstLogin.status).toBe(200);
    expect((await login(account.email)).status).toBe(200);
    expect(await sessionCount(account.id)).toBe(2);
    const original = await getPool().query('SELECT * FROM "user" WHERE id=$1', [account.id]);
    const boardId = randomUUID();
    await getPool().query("INSERT INTO boards(id,owner_id,title) VALUES($1,$2,'Preserved recovery board')", [boardId, account.id]);
    const state = randomBytes(32);
    await getPool().query("INSERT INTO board_documents(board_id,state,revision) VALUES($1,$2,7)", [boardId, state]);
    const boardBefore = await getPool().query("SELECT * FROM boards WHERE id=$1", [boardId]);
    const challenge = await recovery(account.email);
    const nextPassword = randomBytes(24).toString("base64url");
    await challenge.complete(nextPassword);
    expect(await sessionCount(account.id)).toBe(0);
    expect((await getPool().query('SELECT * FROM "user" WHERE id=$1', [account.id])).rows).toEqual(original.rows);
    expect((await getPool().query("SELECT * FROM boards WHERE id=$1", [boardId])).rows).toEqual(boardBefore.rows);
    expect((await getPool().query("SELECT state,revision FROM board_documents WHERE board_id=$1", [boardId])).rows[0])
      .toEqual({ state, revision: "7" });
    expect(await verifyPassword({ password: nextPassword, hash: await passwordHash(account.id) })).toBe(true);
    const oldSession = await authGet(request("/api/auth/get-session", undefined, cookie(firstLogin)));
    expect(await oldSession.json()).toBeNull();
    expect((await login(account.email)).status).toBe(401);
    expect((await login(account.email, nextPassword)).status).toBe(200);
    await expect(challenge.complete(nextPassword)).rejects.toMatchObject({ code: "CHALLENGE_UNAVAILABLE" });
  });

  it("rejects an older recovery process after another process changed the password", async () => {
    const account = await owner();
    const first = await recovery(account.email);
    const stale = await recovery(account.email);
    const nextPassword = randomBytes(24).toString("base64url");
    await first.complete(nextPassword);
    const committed = await passwordHash(account.id);
    await expect(stale.complete(randomBytes(24).toString("base64url"))).rejects.toMatchObject({ code: "ACCOUNT_CHANGED" });
    expect(await passwordHash(account.id)).toBe(committed);
    expect((await login(account.email, nextPassword)).status).toBe(200);
  });

  it("refuses eligibility changes made after the recovery code was issued", async () => {
    const account = await owner();
    expect((await login(account.email)).status).toBe(200);
    const original = await passwordHash(account.id);
    const challenge = await recovery(account.email);
    await getPool().query('UPDATE "user" SET "registrationPending"=true WHERE id=$1', [account.id]);
    await expect(challenge.complete(randomBytes(24).toString("base64url"))).rejects.toMatchObject({ code: "ACCOUNT_CHANGED" });
    expect(await passwordHash(account.id)).toBe(original);
    expect(await sessionCount(account.id)).toBe(1);
  });

  it("rolls back the password update if session revocation fails", async () => {
    const account = await owner();
    expect((await login(account.email)).status).toBe(200);
    const original = await passwordHash(account.id);
    await getPool().query(`CREATE FUNCTION recovery_block_delete() RETURNS trigger LANGUAGE plpgsql AS
      $$ BEGIN RAISE EXCEPTION 'Synthetic session revocation failure'; END $$`);
    await getPool().query("CREATE TRIGGER recovery_block_delete BEFORE DELETE ON session FOR EACH ROW EXECUTE FUNCTION recovery_block_delete()");
    try {
      const challenge = await recovery(account.email);
      await expect(challenge.complete(randomBytes(24).toString("base64url"))).rejects.toThrow("Synthetic session revocation failure");
      expect(await passwordHash(account.id)).toBe(original);
      expect(await sessionCount(account.id)).toBe(1);
    } finally {
      await getPool().query("DROP TRIGGER recovery_block_delete ON session");
      await getPool().query("DROP FUNCTION recovery_block_delete()");
    }
  });

  it("does not let an in-flight old-password login survive a subsequent successful recovery", async () => {
    const account = await owner();
    const challenge = await recovery(account.email);
    const blocker = await getPool().connect();
    let loginRequest: Promise<Response> | undefined;
    await getPool().query(`CREATE FUNCTION recovery_pause_login() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      PERFORM pg_advisory_xact_lock(hashtext(current_database() || ':' || current_schema()), hashtext('recovery-session-reached'));
      PERFORM pg_advisory_xact_lock(hashtext(current_database() || ':' || current_schema()), hashtext('recovery-session-proceed'));
      RETURN NEW; END $$`);
    await getPool().query("CREATE TRIGGER recovery_pause_login BEFORE INSERT ON session FOR EACH ROW EXECUTE FUNCTION recovery_pause_login()");
    try {
      await blocker.query("SELECT pg_advisory_lock(hashtext(current_database() || ':' || current_schema()), hashtext('recovery-session-proceed'))");
      loginRequest = login(account.email);
      void loginRequest.catch(() => undefined);
      await waitUntil(() => lockedElsewhere(blocker, "recovery-session-reached"));
      await expect(challenge.complete(randomBytes(24).toString("base64url"))).rejects.toMatchObject({ code: "CREDENTIAL_OPERATION_BUSY" });
      expect(await verifyPassword({ password, hash: await passwordHash(account.id) })).toBe(true);
    } finally {
      await blocker.query("SELECT pg_advisory_unlock_all()");
      blocker.release();
      if (loginRequest) await loginRequest;
      await getPool().query("DROP TRIGGER recovery_pause_login ON session");
      await getPool().query("DROP FUNCTION recovery_pause_login()");
    }
    const oldLogin = await loginRequest!;
    expect(oldLogin.status).toBe(200);
    expect(await sessionCount(account.id)).toBe(1);
    const nextPassword = randomBytes(24).toString("base64url");
    await (await recovery(account.email)).complete(nextPassword);
    expect(await sessionCount(account.id)).toBe(0);
    const oldSession = await authGet(request("/api/auth/get-session", undefined, cookie(oldLogin)));
    expect(await oldSession.json()).toBeNull();
    expect((await login(account.email)).status).toBe(401);
    expect((await login(account.email, nextPassword)).status).toBe(200);
  });

  it("blocks login and change-password while recovery owns the credential lock", async () => {
    const account = await owner();
    const existing = await login(account.email);
    expect(existing.status).toBe(200);
    const challenge = await recovery(account.email);
    const blocker = await getPool().connect();
    let completion: Promise<void> | undefined;
    const nextPassword = randomBytes(24).toString("base64url");
    try {
      await blocker.query("BEGIN");
      await blocker.query('SELECT id FROM account WHERE "userId"=$1 FOR UPDATE', [account.id]);
      completion = challenge.complete(nextPassword);
      void completion.catch(() => undefined);
      await waitUntil(() => lockedElsewhere(blocker, `rimo-credential:${account.email}`));
      const blockedLogin = await login(account.email);
      expect(blockedLogin.status).toBe(429);
      expect(blockedLogin.headers.get("Retry-After")).toBe("1");
      expect(await blockedLogin.json()).toMatchObject({ code: "CREDENTIAL_OPERATION_BUSY" });
      const blockedChange = await authPost(request("/api/auth/change-password", {
        currentPassword: password, newPassword: randomBytes(24).toString("base64url"),
      }, cookie(existing)));
      expect(blockedChange.status).toBe(429);
      expect(await blockedChange.json()).toMatchObject({ code: "CREDENTIAL_OPERATION_BUSY" });
    } finally {
      await blocker.query("ROLLBACK");
      blocker.release();
      if (completion) await completion;
    }
    expect(await sessionCount(account.id)).toBe(0);
    expect((await login(account.email, nextPassword)).status).toBe(200);
  });

  it("does not overwrite a newer public change-password with a stale recovery proof", async () => {
    const account = await owner();
    const existing = await login(account.email);
    expect(existing.status).toBe(200);
    const stale = await recovery(account.email);
    const nextPassword = randomBytes(24).toString("base64url");
    const changed = await authPost(request("/api/auth/change-password", {
      currentPassword: password, newPassword: nextPassword, revokeOtherSessions: true,
    }, cookie(existing)));
    expect(changed.status).toBe(200);
    await expect(stale.complete(randomBytes(24).toString("base64url"))).rejects.toMatchObject({ code: "ACCOUNT_CHANGED" });
    expect((await login(account.email, nextPassword)).status).toBe(200);
  });
});
