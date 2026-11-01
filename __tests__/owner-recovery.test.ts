// @vitest-environment node

import { randomUUID } from "node:crypto";

import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";

import { beginOwnerRecovery } from "../server/owner-recovery";

const passwordHash = vi.hoisted(() => ({ hash: vi.fn<(password: string) => Promise<string>>() }));
vi.mock("better-auth/crypto", () => ({ hashPassword: passwordHash.hash }));

function fixture(overrides: Record<string, unknown> = {}) {
  let now = 0;
  let code = "";
  const account = { userId: randomUUID(), accountId: randomUUID(), email: "owner@example.test", password: "original-hash",
    emailVerified: true, isAnonymous: false, registrationPending: false, ...overrides };
  const query = vi.fn(async (sql: string) => ({ rows: sql.includes("pg_try_advisory_xact_lock") ? [{ acquired: true }]
    : sql.includes("FOR UPDATE") ? [{ ...account }] : [], rowCount: 1 }));
  const release = vi.fn();
  const database = { query: vi.fn().mockResolvedValue({ rows: [account] }),
    connect: vi.fn().mockResolvedValue({ query, release }) } as unknown as Pool;
  const sendCode = vi.fn(async (_email: string, value: string) => { code = value; });
  passwordHash.hash.mockReset().mockResolvedValue("new-password-hash");
  return { account, database, query, release, sendCode, code: () => code,
    time: (value: number) => { now = value; },
    begin: (email = " OWNER@EXAMPLE.TEST ") => beginOwnerRecovery(email, { database, sendCode, now: () => now }) };
}

describe("ephemeral operator recovery proof", () => {
  it("sends only to the stored verified email and requires its code before hashing a password", async () => {
    const test = fixture();
    const challenge = await test.begin();
    expect(test.sendCode).toHaveBeenCalledExactlyOnceWith("owner@example.test", expect.stringMatching(/^\d{6}$/));
    await expect(challenge.complete("A valid synthetic password 2026!")).rejects.toMatchObject({ code: "PROOF_REQUIRED" });
    expect(passwordHash.hash).not.toHaveBeenCalled();
    expect(test.database.connect).not.toHaveBeenCalled();
  });

  it.each([
    { emailVerified: false }, { isAnonymous: true }, { registrationPending: true },
    { accountId: null }, { password: null }, { password: "" },
  ])("refuses an ineligible account without sending a recovery secret: %j", async (overrides) => {
    const test = fixture(overrides);
    await expect(test.begin()).rejects.toMatchObject({ code: "ACCOUNT_INELIGIBLE" });
    expect(test.sendCode).not.toHaveBeenCalled();
  });

  it("rejects malformed or oversized email before querying the database", async () => {
    const test = fixture();
    for (const email of ["", "invalid", "owner@example.test,other@example.test", `${"a".repeat(250)}@example.test`]) {
      await expect(test.begin(email)).rejects.toMatchObject({ code: "INVALID_EMAIL" });
    }
    expect(test.database.query).not.toHaveBeenCalled();
    expect(test.sendCode).not.toHaveBeenCalled();
  });

  it("refuses missing or ambiguous accounts instead of choosing one credential", async () => {
    const test = fixture();
    vi.mocked(test.database.query).mockResolvedValueOnce({ rows: [] } as never);
    await expect(test.begin()).rejects.toMatchObject({ code: "ACCOUNT_INELIGIBLE" });
    vi.mocked(test.database.query).mockResolvedValueOnce({ rows: [test.account, test.account] } as never);
    await expect(test.begin()).rejects.toMatchObject({ code: "ACCOUNT_INELIGIBLE" });
    expect(test.sendCode).not.toHaveBeenCalled();
  });

  it("permits at most five guesses and permanently consumes an exhausted challenge", async () => {
    const test = fixture();
    const challenge = await test.begin();
    const wrong = test.code() === "000000" ? "111111" : "000000";
    for (let attempt = 0; attempt < 4; attempt += 1) expect(() => challenge.verify(wrong)).toThrow("Код не подошёл");
    expect(() => challenge.verify(wrong)).toThrow("Пять попыток исчерпаны");
    expect(() => challenge.verify(test.code())).toThrow("Восстановление завершено или отменено");
    expect(test.database.connect).not.toHaveBeenCalled();
  });

  it("expires at ten minutes, including time spent after the code was verified", async () => {
    const test = fixture();
    const expired = await test.begin();
    test.time(600_000);
    expect(() => expired.verify(test.code())).toThrow("Срок действия кода истёк");
    test.time(0);
    const verified = await test.begin();
    verified.verify(test.code());
    test.time(600_000);
    await expect(verified.complete("A valid synthetic password 2026!")).rejects.toMatchObject({ code: "CHALLENGE_EXPIRED" });
    expect(passwordHash.hash).not.toHaveBeenCalled();
  });

  it("requires a valid password without consuming the verified proof on input mistakes", async () => {
    const test = fixture();
    const challenge = await test.begin();
    challenge.verify(test.code());
    for (const password of ["short", "a".repeat(129)]) {
      await expect(challenge.complete(password)).rejects.toMatchObject({ code: "PASSWORD_INVALID" });
    }
    await expect(challenge.complete("A valid synthetic password 2026!")).resolves.toBeUndefined();
    expect(passwordHash.hash).toHaveBeenCalledOnce();
    expect(test.query.mock.calls.map(([sql]) => sql).at(-1)).toBe("COMMIT");
    expect(test.query.mock.calls.filter(([sql]) => sql.startsWith("UPDATE"))).toHaveLength(1);
    expect(test.query.mock.calls.some(([sql]) => sql.startsWith("UPDATE account"))).toBe(true);
    expect(test.query.mock.calls.some(([sql]) => sql.startsWith("DELETE FROM session"))).toBe(true);
    expect(test.release).toHaveBeenCalledOnce();
    await expect(challenge.complete("Another valid synthetic password!")).rejects.toMatchObject({ code: "CHALLENGE_UNAVAILABLE" });
  });

  it("cancels without making changes and redacts SMTP delivery failures", async () => {
    const test = fixture();
    const cancelled = await test.begin();
    cancelled.cancel();
    expect(() => cancelled.verify(test.code())).toThrow("Восстановление завершено или отменено");
    test.sendCode.mockRejectedValueOnce(new Error(`SMTP transport contains ${test.code()}`));
    const error = await test.begin().catch((value: unknown) => value);
    expect(error).toMatchObject({ code: "DELIVERY_FAILED" });
    expect(String(error)).not.toContain("SMTP transport");
    expect(String(error)).not.toContain(test.code());
    expect(test.database.connect).not.toHaveBeenCalled();
  });

  it("rechecks proof expiry after slow hashing before any credential mutation", async () => {
    const test = fixture();
    const challenge = await test.begin();
    challenge.verify(test.code());
    passwordHash.hash.mockImplementationOnce(async () => { test.time(600_000); return "new-password-hash"; });
    await expect(challenge.complete("A valid synthetic password 2026!")).rejects.toMatchObject({ code: "CHALLENGE_EXPIRED" });
    expect(test.query.mock.calls.some(([sql]) => sql.startsWith("UPDATE"))).toBe(false);
    expect(test.database.connect).not.toHaveBeenCalled();
  });

  it("honors cancellation while password hashing is in flight", async () => {
    const test = fixture();
    const challenge = await test.begin();
    challenge.verify(test.code());
    passwordHash.hash.mockImplementationOnce(async () => { challenge.cancel(); return "new-password-hash"; });
    await expect(challenge.complete("A valid synthetic password 2026!")).rejects.toMatchObject({ code: "CHALLENGE_UNAVAILABLE" });
    expect(test.database.connect).not.toHaveBeenCalled();
  });
});
