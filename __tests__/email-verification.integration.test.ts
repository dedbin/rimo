// @vitest-environment node

import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  authGet, authPost, cookie, deliveredCode, getPool, login, mail, register,
  request, seedLegacy, sendCode, testDatabaseUrl, useVerificationDatabase, verifyCode,
} from "./email-verification-fixtures";
import { createCollaborationDependencies } from "../collaboration-server/dependencies";
import { GET as listBoards } from "../app/api/boards/route";
import { POST as acceptInvite } from "../app/api/invites/accept/route";
import { createInvite } from "../server/invites";
import { getCollaborationRole } from "../server/collaboration-access";

async function expireSendLimits(): Promise<void> {
  await getPool().query('UPDATE email_verification_limits SET "windowStart"=now()-interval \'11 minutes\'');
}

async function currentUser(id: string): Promise<{ emailVerified: boolean; registrationPending: boolean }> {
  const result = await getPool().query<{ emailVerified: boolean; registrationPending: boolean }>(
    'SELECT "emailVerified", "registrationPending" FROM "user" WHERE id=$1', [id],
  );
  return result.rows[0];
}

describe.skipIf(!testDatabaseUrl)("email verification through real Better Auth and PostgreSQL", () => {
  useVerificationDatabase("rimo_email_verification");

  it("stores a hash, expires after ten minutes and rejects an expired code", async () => {
    const owner = await register();
    const startedAt = Date.now();
    expect((await sendCode(owner.email)).status).toBe(200);
    const otp = deliveredCode(owner.email);
    const result = await getPool().query<{ value: string; expiresAt: Date }>(
      'SELECT value,"expiresAt" FROM verification WHERE identifier=$1', [`email-verification-otp-${owner.email}`],
    );
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].value).not.toContain(otp);
    expect(result.rows[0].expiresAt.getTime() - startedAt).toBeGreaterThan(590_000);
    expect(result.rows[0].expiresAt.getTime() - startedAt).toBeLessThan(610_000);
    await getPool().query('UPDATE verification SET "expiresAt"=$1', [new Date(Date.now() - 60_000)]);
    const expiredRecord = await getPool().query<{ expiresAt: Date }>('SELECT "expiresAt" FROM verification');
    expect(expiredRecord.rows[0].expiresAt.getTime()).toBeLessThan(Date.now());
    const expired = await verifyCode(owner.email, otp);
    expect(expired.status).toBe(400);
    expect(await expired.json()).toMatchObject({ code: "OTP_EXPIRED" });
    expect(await currentUser(owner.id)).toEqual({ emailVerified: false, registrationPending: true });
  });

  it("limits wrong guesses to five attempts and consumes the successful code once", async () => {
    const owner = await register();
    expect((await sendCode(owner.email)).status).toBe(200);
    const otp = deliveredCode(owner.email);
    const wrong = otp === "000000" ? "111111" : "000000";
    for (let index = 0; index < 5; index += 1) {
      const rejected = await verifyCode(owner.email, wrong);
      expect(rejected.status).toBe(400);
      expect(await rejected.json()).toMatchObject({ code: "INVALID_OTP" });
    }
    const exhausted = await verifyCode(owner.email, otp);
    expect(exhausted.status).toBe(403);
    expect(await exhausted.json()).toMatchObject({ code: "TOO_MANY_ATTEMPTS" });
    expect(await currentUser(owner.id)).toEqual({ emailVerified: false, registrationPending: true });
    await expireSendLimits();
    expect((await sendCode(owner.email)).status).toBe(200);
    const fresh = deliveredCode(owner.email);
    const results = await Promise.all([verifyCode(owner.email, fresh), verifyCode(owner.email, fresh)]);
    expect(results.filter(response => response.status === 200)).toHaveLength(1);
    expect([400, 429]).toContain(results.find(response => response.status !== 200)!.status);
    expect(cookie(results.find(response => response.status === 200)!)).not.toContain("session_token");
    expect((await verifyCode(owner.email, fresh)).status).toBe(400);
  });

  it("rotates the code after resend and enforces the address cooldown across clients", async () => {
    const owner = await register();
    expect((await sendCode(owner.email)).status).toBe(200);
    const first = deliveredCode(owner.email);
    const blocked = await sendCode(owner.email.toUpperCase());
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers.get("Retry-After"))).toBeGreaterThan(0);
    expect(mail.send).toHaveBeenCalledTimes(1);
    await expireSendLimits();
    expect((await sendCode(owner.email)).status).toBe(200);
    let fresh = deliveredCode(owner.email);
    // Random generation can repeat the same six digits; the assertion concerns replaced records.
    if (fresh === first) {
      await expireSendLimits();
      expect((await sendCode(owner.email)).status).toBe(200);
      fresh = deliveredCode(owner.email);
    }
    expect(fresh).not.toBe(first);
    expect((await verifyCode(owner.email, first)).status).toBe(400);
    expect((await verifyCode(owner.email, fresh)).status).toBe(200);
  });

  it("allows at most five send requests per IP in ten minutes and handles SMTP failure safely", async () => {
    const ip = "198.51.100.230";
    const accounts = await Promise.all(Array.from({ length: 6 }, () => register()));
    for (const account of accounts.slice(0, 5)) expect((await sendCode(account.email, ip)).status).toBe(200);
    const limited = await sendCode(accounts[5].email, ip);
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get("Retry-After"))).toBeGreaterThan(500);
    expect(mail.send).toHaveBeenCalledTimes(5);
    mail.send.mockRejectedValueOnce(new Error("Synthetic transport detail must stay private"));
    const failed = await sendCode(accounts[5].email);
    expect(failed.status).toBe(503);
    const failure = await failed.json();
    expect(failure).toMatchObject({ code: "MAIL_SEND_FAILED" });
    expect(JSON.stringify(failure)).not.toContain("Synthetic transport detail");
    expect((await login(accounts[5].email)).status).toBe(403);
  });

  it("atomically activates only one of two pending owners competing for the last slot", async () => {
    for (let index = 0; index < 5; index += 1) await seedLegacy();
    const owners = await Promise.all([register(), register()]);
    for (const owner of owners) expect((await sendCode(owner.email)).status).toBe(200);
    const results = await Promise.all(owners.map(owner => verifyCode(owner.email, deliveredCode(owner.email))));
    expect(results.map(response => response.status).sort()).toEqual([200, 409]);
    const rejected = results.find(response => response.status === 409)!;
    expect(await rejected.json()).toMatchObject({ code: "OWNER_LIMIT_REACHED" });
    const states = await Promise.all(owners.map(owner => currentUser(owner.id)));
    expect(states.filter(user => user.emailVerified && !user.registrationPending)).toHaveLength(1);
    expect(states.filter(user => !user.emailVerified && user.registrationPending)).toHaveLength(1);
    const active = await getPool().query<{ total: string }>(
      'SELECT count(*) AS total FROM "user" WHERE NOT "isAnonymous" AND NOT "registrationPending"',
    );
    expect(active.rows[0].total).toBe("6");
    const remaining = owners[results.findIndex(response => response.status === 409)];
    expect((await verifyCode(remaining.email, deliveredCode(remaining.email))).status).toBe(400);
  });

  it("gates an existing session and WebSocket until confirmation without losing its board or reserved slot", async () => {
    const owner = await register();
    await getPool().query('UPDATE "user" SET "emailVerified"=true,"registrationPending"=false WHERE id=$1', [owner.id]);
    const loggedIn = await login(owner.email);
    expect(loggedIn.status).toBe(200);
    const sessionCookie = cookie(loggedIn);
    const authenticated = await authGet(request("/api/auth/get-session", undefined, sessionCookie));
    const session = (await authenticated.json()).session as { id: string };
    const boardId = randomUUID();
    await getPool().query("INSERT INTO boards(id,owner_id,title) VALUES($1,$2,'Существующая доска')", [boardId, owner.id]);
    await getPool().query('UPDATE "user" SET "emailVerified"=false WHERE id=$1', [owner.id]);
    for (let index = 0; index < 5; index += 1) await seedLegacy();
    const denied = await listBoards(request("/api/boards", undefined, sessionCookie));
    expect(denied.status).toBe(403);
    expect(await denied.json()).toMatchObject({ error: { code: "EMAIL_NOT_VERIFIED" } });
    expect(await getCollaborationRole(session.id, owner.id, boardId)).toBeNull();
    const dependencies = createCollaborationDependencies();
    expect(await dependencies.authenticate(new Headers({ cookie: sessionCookie }), boardId)).toBeNull();
    const ownSession = await authGet(request("/api/auth/get-session", undefined, sessionCookie));
    expect((await ownSession.json()).user.id).toBe(owner.id);
    const tampered = await authPost(request("/api/auth/update-user", {
      name: "Попытка обхода", emailVerified: true, registrationPending: false,
    }, sessionCookie));
    expect(tampered.status).toBe(403);
    expect(await currentUser(owner.id)).toEqual({ emailVerified: false, registrationPending: false });
    expect((await sendCode(owner.email)).status).toBe(200);
    expect((await verifyCode(owner.email, deliveredCode(owner.email))).status).toBe(200);
    expect((await listBoards(request("/api/boards", undefined, sessionCookie))).status).toBe(200);
    expect(await getCollaborationRole(session.id, owner.id, boardId)).toBe("owner");
    expect((await dependencies.authenticate(new Headers({ cookie: sessionCookie }), boardId))?.role).toBe("owner");
    expect((await getPool().query("SELECT title FROM boards WHERE id=$1", [boardId])).rows[0].title).toBe("Существующая доска");
  });

  it("keeps an anonymous guest invitation working without email confirmation", async () => {
    const ownerId = await seedLegacy(true);
    const boardId = randomUUID();
    await getPool().query("INSERT INTO boards(id,owner_id,title) VALUES($1,$2,'Гостевая доска')", [boardId, ownerId]);
    const invite = await createInvite(boardId, ownerId, "editor");
    const anonymous = await authPost(request("/api/auth/sign-in/anonymous", {}));
    expect(anonymous.status).toBe(200);
    const guestCookie = cookie(anonymous);
    const guest = (await anonymous.json()).user as { id: string };
    const accepted = await acceptInvite(request("/api/invites/accept", { token: invite.token, name: "Ученик" }, guestCookie));
    expect(accepted.status).toBe(200);
    const ownSession = await authGet(request("/api/auth/get-session", undefined, guestCookie));
    const data = await ownSession.json();
    expect(await getCollaborationRole(data.session.id, guest.id, boardId)).toBe("editor");
    expect(mail.send).not.toHaveBeenCalled();
  });

  it("blocks code-only login, recovery, link verification and extra OTP types", async () => {
    const owner = await register();
    for (const path of [
      "/sign-in/email-otp", "/email-otp/check-verification-otp", "/email-otp/request-password-reset",
      "/forget-password/email-otp", "/email-otp/reset-password", "/email-otp/request-email-change",
      "/email-otp/change-email", "/send-verification-email",
    ]) {
      const response = await authPost(request(`/api/auth${path}`, { email: owner.email, otp: "123456", type: "email-verification" }));
      expect(response.status, path).toBe(404);
    }
    expect((await authGet(request("/api/auth/verify-email?token=synthetic"))).status).toBe(404);
    for (const type of ["sign-in", "forget-password", "change-email"]) {
      const rejected = await authPost(request("/api/auth/email-otp/send-verification-otp", { email: owner.email, type }));
      expect(rejected.status).toBeGreaterThanOrEqual(400);
      expect(rejected.status).toBeLessThan(500);
    }
    const crossSite = await authPost(request("/api/auth/email-otp/send-verification-otp", { email: owner.email, type: "email-verification" }, undefined, "https://other.example.test"));
    expect(crossSite.status).toBe(403);
    expect(mail.send).not.toHaveBeenCalled();
    const unknown = await sendCode(`${randomUUID()}@example.test`);
    expect(unknown.status).toBe(403);
    expect(await unknown.json()).toMatchObject({ code: "VERIFICATION_REQUIRED" });
    expect(mail.send).not.toHaveBeenCalled();
    expect(await currentUser(owner.id)).toEqual({ emailVerified: false, registrationPending: true });
  });

  it("requires proof of the original credentials before confirming an attacker-preseeded address", async () => {
    const attackerPassword = "Attacker synthetic password 2026!";
    const victimPassword = "Victim different synthetic password 2026!";
    const account = await register({ name: "Первый браузер", email: `${randomUUID()}@example.test`, password: attackerPassword });
    const duplicate = await authPost(request("/api/auth/sign-up/email", {
      name: "Второй браузер", email: account.email, password: victimPassword,
    }));
    expect(duplicate.status).toBe(200);
    expect(/rimo\.email_verification=[^;]+/.test(cookie(duplicate))).toBe(false);
    expect(cookie(duplicate)).not.toContain("session_token");
    expect((await sendCode(account.email)).status).toBe(200);
    const code = deliveredCode(account.email);
    const unprovedSend = await authPost(request("/api/auth/email-otp/send-verification-otp", {
      email: account.email, type: "email-verification",
    }));
    expect(unprovedSend.status).toBe(403);
    expect(await unprovedSend.json()).toMatchObject({ code: "VERIFICATION_REQUIRED" });
    const unprovedVerify = await authPost(request("/api/auth/email-otp/verify-email", { email: account.email, otp: code }));
    expect(unprovedVerify.status).toBe(403);
    expect(await unprovedVerify.json()).toMatchObject({ code: "VERIFICATION_REQUIRED" });
    expect(await currentUser(account.id)).toEqual({ emailVerified: false, registrationPending: true });
    const victimLogin = await login(account.email, victimPassword);
    expect(victimLogin.status).toBe(401);
    expect(cookie(victimLogin)).not.toContain("session_token");
    const attackerLogin = await login(account.email, attackerPassword);
    expect(attackerLogin.status).toBe(403);
    expect(await attackerLogin.json()).toMatchObject({ code: "EMAIL_NOT_VERIFIED" });
    expect(cookie(attackerLogin)).toContain("rimo.email_verification=");
    expect(cookie(attackerLogin)).not.toContain("session_token");
    const noSession = await authGet(request("/api/auth/get-session", undefined, cookie(attackerLogin)));
    expect(await noSession.json()).toBeNull();
    expect(await currentUser(account.id)).toEqual({ emailVerified: false, registrationPending: true });
  });
});
