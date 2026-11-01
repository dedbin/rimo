// @vitest-environment node

import { randomUUID } from "node:crypto";

import { createAuthClient } from "better-auth/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  authGet, authPost, cookie, credentials, deliveredCode, getPool, login, mail, origin,
  password, register, request, seedLegacy, sendCode, testDatabaseUrl,
  useVerificationDatabase, verifyCode,
} from "./email-verification-fixtures";
import { GET as getBoard } from "../app/api/boards/[boardId]/route";
import { GET as listBoards, POST as createBoard } from "../app/api/boards/route";

async function accountCounts(): Promise<{ active: string; pending: string; guests: string }> {
  const result = await getPool().query<{ active: string; pending: string; guests: string }>(
    `SELECT count(*) FILTER (WHERE NOT "isAnonymous" AND NOT "registrationPending") AS active,
      count(*) FILTER (WHERE NOT "isAnonymous" AND "registrationPending") AS pending,
      count(*) FILTER (WHERE "isAnonymous") AS guests FROM "user"`,
  );
  return result.rows[0];
}

describe.skipIf(!testDatabaseUrl)("public registration with mandatory email confirmation", () => {
  useVerificationDatabase("rimo_registration_test");
  beforeEach(() => { vi.stubEnv("REGISTRATION_MODE", "open"); });

  it("keeps session reads available for a shared classroom while enforcing a finite trusted-IP budget", async () => {
    const owner = await register();
    expect((await sendCode(owner.email)).status).toBe(200);
    expect((await verifyCode(owner.email, deliveredCode(owner.email))).status).toBe(200);
    const sessionCookie = cookie(await login(owner.email));
    for (let index = 0; index < 240; index += 1) {
      const forwarded = `${index % 2 ? "192.0.2.1" : "192.0.2.2"}, 203.0.113.223`;
      const response = await authGet(request("/api/auth/get-session", undefined, sessionCookie, origin, forwarded));
      expect(response.status).toBe(200);
      const data = await response.json() as { user?: { id?: string } };
      expect(data.user?.id === owner.id).toBe(true);
    }
    const limited = await authGet(request("/api/auth/get-session", undefined, sessionCookie, origin, "192.0.2.3, 203.0.113.223"));
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get("Retry-After"))).toBeGreaterThan(0);
    expect(limited.headers.get("Cache-Control")).toBe("no-store");
    const otherAddress = await authGet(request("/api/auth/get-session", undefined, sessionCookie, origin, "203.0.113.224"));
    expect(otherAddress.status).toBe(200);
  });

  it("requires a code before password login, keeps workspaces private and creates no code-only session", async () => {
    const existing = await seedLegacy(true);
    const foreignBoard = randomUUID();
    await getPool().query("INSERT INTO boards(id, owner_id, title) VALUES ($1,$2,$3)", [foreignBoard, existing, "Чужая доска"]);
    const owner = await register();
    expect(mail.send).not.toHaveBeenCalled();
    expect(await accountCounts()).toMatchObject({ active: "1", pending: "1" });
    const anonymousSession = await authGet(request("/api/auth/get-session"));
    expect(await anonymousSession.json()).toBeNull();
    const premature = await login(owner.email);
    expect(premature.status).toBe(403);
    expect(await premature.json()).toMatchObject({ code: "EMAIL_NOT_VERIFIED" });
    const challenge = premature.headers.getSetCookie().find(value => value.startsWith("rimo.email_verification="));
    expect(challenge?.includes("HttpOnly")).toBe(true);
    expect(challenge?.includes("Max-Age=1800")).toBe(true);
    expect(cookie(premature)).not.toContain("session_token");
    expect((await sendCode(owner.email)).status).toBe(200);
    const verified = await verifyCode(owner.email, deliveredCode(owner.email));
    expect(verified.status).toBe(200);
    expect(cookie(verified)).not.toContain("session_token");
    expect(verified.headers.getSetCookie().find(value => value.startsWith("rimo.email_verification="))?.includes("Max-Age=0")).toBe(true);
    expect(await accountCounts()).toMatchObject({ active: "2", pending: "0" });
    const loggedIn = await login(owner.email);
    expect(loggedIn.status).toBe(200);
    const sessionCookie = cookie(loggedIn);
    expect(sessionCookie).toContain("session_token");
    const session = await authGet(request("/api/auth/get-session", undefined, sessionCookie));
    expect((await session.json()).user).toMatchObject({ id: owner.id, emailVerified: true });
    const boards = await listBoards(request("/api/boards", undefined, sessionCookie));
    expect(await boards.json()).toEqual({ boards: [] });
    const foreign = await getBoard(request(`/api/boards/${foreignBoard}`, undefined, sessionCookie), {
      params: Promise.resolve({ boardId: foreignBoard }),
    });
    expect(foreign.status).toBe(404);
    const own = await createBoard(request("/api/boards", { title: "Моя доска" }, sessionCookie));
    expect(own.status).toBe(201);
    expect((await own.json()).board.ownerId).toBe(owner.id);
    expect((await login(owner.email)).status).toBe(200);
  });

  it("keeps validation and origin checks while duplicate registration reveals no account or replaces credentials", async () => {
    const input = credentials();
    for (const body of [
      { ...input, password: "short" }, { ...input, email: "not-an-email" },
      { ...input, name: " " }, { ...input, image: "javascript:alert(1)" },
    ]) {
      const response = await authPost(request("/api/auth/sign-up/email", body));
      expect(response.status).toBeGreaterThanOrEqual(400);
      expect(response.status).toBeLessThan(500);
    }
    const crossSite = await authPost(request("/api/auth/sign-up/email", input, undefined, "https://other.example.test"));
    expect(crossSite.status).toBe(403);
    const account = await register(input);
    const duplicate = await authPost(request("/api/auth/sign-up/email", { ...input, password: "Another synthetic password 2026!" }));
    expect(duplicate.status).toBe(200);
    expect(cookie(duplicate)).not.toContain("session_token");
    expect(/rimo\.email_verification=[^;]+/.test(cookie(duplicate))).toBe(false);
    expect((await duplicate.json()).user).toMatchObject({ emailVerified: false, registrationPending: true });
    expect(await accountCounts()).toMatchObject({ active: "0", pending: "1" });
    await sendCode(account.email);
    expect((await verifyCode(account.email, deliveredCode(account.email))).status).toBe(200);
    expect((await login(account.email, password)).status).toBe(200);
    expect((await login(account.email, "Another synthetic password 2026!")).status).toBe(401);
    const statuses: number[] = [];
    for (let index = 0; index < 4; index += 1) {
      statuses.push((await authPost(request("/api/auth/sign-up/email", { ...credentials(), password: "short" }, undefined, origin, "198.51.100.250"))).status);
    }
    expect(statuses).toEqual([400, 400, 400, 429]);
  });

  it("reserves existing owner slots, excludes pending accounts and returns SDK-readable quota errors", async () => {
    for (let index = 0; index < 5; index += 1) await seedLegacy();
    for (let index = 0; index < 8; index += 1) await seedLegacy(false, true);
    await Promise.all([register(), register()]);
    expect(await accountCounts()).toEqual({ active: "5", pending: "2", guests: "8" });
    await seedLegacy();
    const client = createAuthClient({ baseURL: origin, fetchOptions: {
      customFetchImpl: async (url, init) => {
        const outgoing = new Request(url, init);
        outgoing.headers.set("Origin", origin);
        return authPost(outgoing);
      },
    } });
    const result = await client.signUp.email(credentials());
    expect(result.error).toMatchObject({ code: "OWNER_LIMIT_REACHED", status: 409 });
  });

  it("keeps anonymous sign-in and prevents alternate signup or client-controlled verification fields", async () => {
    const input = credentials();
    const registration = await authPost(request("/api/auth/sign-up/email", {
      ...input, registrationPending: false, emailVerified: true,
    }));
    expect(registration.status).toBe(200);
    const user = await getPool().query<{ registrationPending: boolean; emailVerified: boolean }>(
      'SELECT "registrationPending", "emailVerified" FROM "user" WHERE email=$1', [input.email],
    );
    expect(user.rows[0]).toEqual({ registrationPending: true, emailVerified: false });
    for (let index = 0; index < 6; index += 1) await seedLegacy();
    expect((await authPost(request("/api/auth/sign-up/email/", credentials()))).status).toBe(409);
    for (const pathname of ["/api/auth/sign-up/%65mail", "/api/auth/sign-up//email"]) {
      expect((await authPost(request(pathname, credentials()))).status).toBeGreaterThanOrEqual(400);
    }
    const guest = await authPost(request("/api/auth/sign-in/anonymous", {}));
    expect(guest.status).toBe(200);
    expect((await guest.json()).user.isAnonymous).toBe(true);
    expect(await accountCounts()).toMatchObject({ active: "6", pending: "1" });
  });

  it("closes only new sign-ups, keeping pending confirmation, existing login and guests available", async () => {
    const pending = await register();
    const existing = await register();
    expect((await sendCode(existing.email)).status).toBe(200);
    expect((await verifyCode(existing.email, deliveredCode(existing.email))).status).toBe(200);
    vi.stubEnv("REGISTRATION_MODE", "closed");
    const rejected = await authPost(request("/api/auth/sign-up/email", credentials()));
    expect(rejected.status).toBe(403);
    expect(await rejected.json()).toMatchObject({ code: "REGISTRATION_CLOSED" });
    expect(rejected.headers.get("Cache-Control")).toBe("no-store");
    expect(await accountCounts()).toMatchObject({ active: "1", pending: "1" });
    expect((await login(existing.email)).status).toBe(200);
    expect((await sendCode(pending.email)).status).toBe(200);
    expect((await verifyCode(pending.email, deliveredCode(pending.email))).status).toBe(200);
    expect((await login(pending.email)).status).toBe(200);
    expect((await authPost(request("/api/auth/sign-in/anonymous", {}))).status).toBe(200);
    expect(await accountCounts()).toMatchObject({ active: "2", pending: "0", guests: "1" });
  });

  it("accepts owners above the six-account pilot only under an explicit finite cap", async () => {
    vi.stubEnv("MAX_OWNERS", "8");
    try {
      for (let index = 0; index < 6; index += 1) await seedLegacy();
      const accounts = await Promise.all([register(), register()]);
      for (const account of accounts) expect((await sendCode(account.email)).status).toBe(200);
      const confirmations = await Promise.all(accounts.map(account => verifyCode(account.email, deliveredCode(account.email))));
      expect(confirmations.map(response => response.status)).toEqual([200, 200]);
      expect(await accountCounts()).toMatchObject({ active: "8", pending: "0" });
      const rejected = await authPost(request("/api/auth/sign-up/email", credentials()));
      expect(rejected.status).toBe(409);
      expect(await rejected.json()).toMatchObject({ code: "OWNER_LIMIT_REACHED" });
      expect((await login(accounts[0].email)).status).toBe(200);
    } finally { vi.stubEnv("MAX_OWNERS", "6"); }
  });

  it("keeps a shared NAT sign-up budget despite changing spoofed forwarded prefixes", async () => {
    const statuses: number[] = [];
    for (let index = 0; index < 4; index += 1) {
      const response = await authPost(request("/api/auth/sign-up/email", { ...credentials(), password: "short" },
        undefined, origin, `192.0.2.${index + 1}, 198.51.100.241`));
      statuses.push(response.status);
      if (index === 3) expect(Number(response.headers.get("Retry-After"))).toBeGreaterThan(0);
    }
    expect(statuses).toEqual([400, 400, 400, 429]);
    expect(await accountCounts()).toMatchObject({ active: "0", pending: "0" });
    expect(mail.send).not.toHaveBeenCalled();
  });

  it("shares the OTP budget across a NAT and does not trust client-controlled leftmost addresses", async () => {
    const accounts = await Promise.all(Array.from({ length: 6 }, () => register()));
    for (const [index, account] of accounts.entries()) {
      const response = await sendCode(account.email, `192.0.2.${index + 1}, 198.51.100.242`);
      expect(response.status).toBe(index < 5 ? 200 : 429);
      if (index === 5) expect(Number(response.headers.get("Retry-After"))).toBeGreaterThan(500);
    }
    expect(mail.send).toHaveBeenCalledTimes(5);
  });
});
