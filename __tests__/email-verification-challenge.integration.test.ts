// @vitest-environment node

import { describe, expect, it, vi } from "vitest";

import {
  authPost, cookie, deliveredCode, getPool, login, mail, origin, register, request,
  sendCode, testDatabaseUrl, useVerificationDatabase, verificationCookie, verifyCode,
} from "./email-verification-fixtures";

function corruptSignature(proof: string): string {
  return proof.replace(/^(rimo\.email_verification=[^.]+\.)(.)(.*)$/, (_match, prefix: string, first: string, rest: string) =>
    `${prefix}${first === "A" ? "B" : "A"}${rest}`);
}

async function storedCode(email: string): Promise<unknown[]> {
  return (await getPool().query('SELECT value,"expiresAt" FROM verification WHERE identifier=$1',
    [`email-verification-otp-${email}`])).rows;
}

async function deniedProofCalls(email: string, otp: string, proof: string): Promise<void> {
  const sending = await authPost(request("/api/auth/email-otp/send-verification-otp", {
    email, type: "email-verification",
  }, proof));
  expect(sending.status).toBe(403);
  expect(await sending.json()).toMatchObject({ code: "VERIFICATION_REQUIRED" });
  const verifying = await authPost(request("/api/auth/email-otp/verify-email", { email, otp }, proof));
  expect(verifying.status).toBe(403);
  expect(await verifying.json()).toMatchObject({ code: "VERIFICATION_REQUIRED" });
}

describe.skipIf(!testDatabaseUrl)("credential proof cookies for email verification", () => {
  useVerificationDatabase("rimo_verification_challenge");

  it.each(["tampered", "expired", "another email"] as const)("rejects a %s challenge before sending or consuming a code", async (kind) => {
    const owner = await register();
    expect((await sendCode(owner.email)).status).toBe(200);
    const otp = deliveredCode(owner.email);
    const before = await storedCode(owner.email);
    const rateUsage = await getPool().query('SELECT key,count FROM email_verification_limits ORDER BY key');
    let proof = verificationCookie(owner.email)!;
    if (kind === "tampered") proof = corruptSignature(proof);
    if (kind === "another email") proof = verificationCookie((await register()).email)!;
    const clock = kind === "expired" ? vi.spyOn(Date, "now").mockReturnValue(Date.now() + 1_900_000) : null;
    try {
      await deniedProofCalls(owner.email, otp, proof);
    } finally {
      clock?.mockRestore();
    }
    expect(mail.send).toHaveBeenCalledTimes(1);
    expect(await storedCode(owner.email)).toEqual(before);
    expect((await getPool().query('SELECT key,count FROM email_verification_limits ORDER BY key')).rows).toEqual(rateUsage.rows);
    const status = await getPool().query('SELECT "emailVerified","registrationPending" FROM "user" WHERE id=$1', [owner.id]);
    expect(status.rows[0]).toEqual({ emailVerified: false, registrationPending: true });
    expect((await verifyCode(owner.email, otp)).status).toBe(200);
  });

  it("renews expired proof only after a correct password and completes verification with the renewed cookie", async () => {
    const owner = await register();
    expect((await sendCode(owner.email)).status).toBe(200);
    const otp = deliveredCode(owner.email);
    const original = verificationCookie(owner.email)!;
    const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 1_900_000);
    try {
      await deniedProofCalls(owner.email, otp, original);
    } finally {
      clock.mockRestore();
    }
    const wrongPassword = await login(owner.email, "A different synthetic password 2026!");
    expect(wrongPassword.status).toBe(401);
    expect(/rimo\.email_verification=[^;]+/.test(cookie(wrongPassword))).toBe(false);
    const renewed = await login(owner.email, owner.password);
    expect(renewed.status).toBe(403);
    expect(await renewed.json()).toMatchObject({ code: "EMAIL_NOT_VERIFIED" });
    expect(/rimo\.email_verification=[^;]+/.test(cookie(renewed))).toBe(true);
    expect(cookie(renewed) === original).toBe(false);
    expect(cookie(renewed).includes("session_token=")).toBe(false);
    const confirmed = await verifyCode(owner.email, otp);
    expect(confirmed.status).toBe(200);
    expect(confirmed.headers.getSetCookie().some(value => value.startsWith("rimo.email_verification=") && value.includes("Max-Age=0"))).toBe(true);
    expect((await login(owner.email, owner.password)).status).toBe(200);
  });

  it("shares the per-IP send limit across canonical trailing slashes and blocks encoded path aliases", async () => {
    const owners = await Promise.all(Array.from({ length: 6 }, () => register()));
    const clientIp = "198.51.100.231";
    for (const [index, owner] of owners.slice(0, 5).entries()) {
      const pathname = `/api/auth/email-otp/send-verification-otp${index % 2 ? "/" : ""}`;
      const response = await authPost(request(pathname, { email: owner.email, type: "email-verification" }, verificationCookie(owner.email), origin, clientIp));
      expect(response.status).toBe(200);
    }
    const last = owners[5];
    for (const pathname of ["/api/auth/email-otp/send-verification-otp", "/api/auth/email-otp/send-verification-otp/"]) {
      const limited = await authPost(request(pathname, { email: last.email, type: "email-verification" }, verificationCookie(last.email), origin, clientIp));
      expect(limited.status).toBe(429);
      expect(Number(limited.headers.get("Retry-After"))).toBeGreaterThan(0);
    }
    for (const pathname of ["/api/auth/email-otp/%73end-verification-otp", "/api/auth//email-otp/send-verification-otp"]) {
      const alias = await authPost(request(pathname, { email: last.email, type: "email-verification" }, verificationCookie(last.email), origin, clientIp));
      expect(alias.status).toBe(404);
    }
    expect(mail.send).toHaveBeenCalledTimes(5);
  });
});
