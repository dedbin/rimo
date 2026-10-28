// @vitest-environment node

import { describe, expect, it } from "vitest";

import { withVerificationCodeLock } from "../server/email-verification-lock";
import {
  getPool, mail, register, sendCode, testDatabaseUrl, useVerificationDatabase,
} from "./email-verification-fixtures";

describe.skipIf(!testDatabaseUrl)("email code operation serialization", () => {
  useVerificationDatabase("rimo_code_lock_test");

  it("rejects a concurrent send without spending either budget or changing the code", async () => {
    const account = await register();
    let entered!: () => void;
    let release!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const finish = new Promise<void>(resolve => { release = resolve; });
    const holder = withVerificationCodeLock(account.email, async () => {
      entered();
      await finish;
    });
    await started;
    try {
      const result = await sendCode(account.email);
      expect(result.status).toBe(429);
      expect(result.headers.get("Retry-After")).toBe("1");
      expect(mail.send).not.toHaveBeenCalled();
      expect((await getPool().query('SELECT count(*)::int AS count FROM email_verification_limits')).rows[0].count).toBe(0);
      expect((await getPool().query('SELECT count(*)::int AS count FROM verification')).rows[0].count).toBe(0);
    } finally {
      release();
      await holder;
    }
    expect((await sendCode(account.email)).status).toBe(200);
  });

  it("keeps main database connections available for many different addresses", async () => {
    const values = await Promise.all(Array.from({ length: 12 }, (_, index) =>
      withVerificationCodeLock(`parallel-${index}@example.test`, async () => {
        const result = await getPool().query<{ value: number }>("SELECT 1 AS value");
        return result.rows[0].value;
      }),
    ));
    expect(values).toEqual(Array(12).fill(1));
  });
});
