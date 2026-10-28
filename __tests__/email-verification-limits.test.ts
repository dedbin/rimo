// @vitest-environment node

import { createHash } from "node:crypto";

import { beforeEach, describe, expect, it, vi } from "vitest";

import { assertVerificationSendAllowed, VerificationSendLimitError } from "../server/email-verification-limits";

const database = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock("../server/db", () => ({
  inTransaction: async (run: (client: { query: typeof database.query }) => Promise<void>) =>
    run({ query: database.query }),
}));

const now = new Date("2026-10-28T12:00:00.000Z");
function key(kind: "email" | "ip", value: string): string {
  return `${kind}:${createHash("sha256").update(value).digest("hex")}`;
}

interface Row {
  readonly key: string;
  readonly windowStart: Date;
  readonly count: number;
}

function mockBudgets(rows: readonly Row[] = []): void {
  database.query.mockImplementation(async (sql: string) => {
    if (sql.includes("clock_timestamp()")) return { rows: [{ now }] };
    if (sql.startsWith("SELECT key")) return { rows };
    return { rows: [] };
  });
}

function writes(): unknown[][] {
  return database.query.mock.calls
    .filter(([sql]) => sql.includes("INSERT INTO email_verification_limits"))
    .map(([, values]) => values);
}

beforeEach(() => { database.query.mockReset(); mockBudgets(); });

describe("database-backed verification send budgets", () => {
  it("normalizes email, hashes both identifiers and acquires locks before reading budgets", async () => {
    await assertVerificationSendAllowed(" Teacher@Example.Test ", "198.51.100.1");
    const expected = [key("email", "teacher@example.test"), key("ip", "198.51.100.1")];
    const locks = database.query.mock.calls.filter(([sql]) => sql.includes("pg_advisory_xact_lock"));
    expect(locks.map(([, values]) => values[0])).toEqual(expected.toSorted().map((value) => `rimo-email-limit:${value}`));
    expect(database.query.mock.calls[0][0]).toContain("pg_advisory_xact_lock");
    expect(database.query.mock.calls[1][0]).toContain("pg_advisory_xact_lock");
    expect(writes()).toEqual(expected.map((value) => [value, now, 1]));
    expect(JSON.stringify(database.query.mock.calls)).not.toContain("teacher@example.test");
    expect(JSON.stringify(database.query.mock.calls)).not.toContain("198.51.100.1");
  });

  it("rejects an address inside its cooldown without consuming the IP budget", async () => {
    mockBudgets([{ key: key("email", "teacher@example.test"), windowStart: new Date(now.getTime() - 10_001), count: 1 }]);
    await expect(assertVerificationSendAllowed("teacher@example.test", "198.51.100.1"))
      .rejects.toMatchObject({ status: 429, retryAfter: 50 });
    expect(writes()).toEqual([]);
  });

  it("rejects a sixth request from an IP even when the email budget is available", async () => {
    mockBudgets([{ key: key("ip", "198.51.100.1"), windowStart: new Date(now.getTime() - 590_100), count: 5 }]);
    await expect(assertVerificationSendAllowed("teacher@example.test", "198.51.100.1"))
      .rejects.toMatchObject({ status: 429, retryAfter: 10 });
    expect(writes()).toEqual([]);
  });

  it("waits for both blocked budgets and rounds Retry-After up to at least one second", async () => {
    mockBudgets([
      { key: key("email", "teacher@example.test"), windowStart: new Date(now.getTime() - 59_999), count: 1 },
      { key: key("ip", "198.51.100.1"), windowStart: new Date(now.getTime() - 550_000), count: 5 },
    ]);
    await expect(assertVerificationSendAllowed("teacher@example.test", "198.51.100.1"))
      .rejects.toMatchObject({ retryAfter: 50 });
    mockBudgets([{ key: key("email", "teacher@example.test"), windowStart: new Date(now.getTime() - 59_999), count: 1 }]);
    await expect(assertVerificationSendAllowed("teacher@example.test", "198.51.100.1"))
      .rejects.toMatchObject({ retryAfter: 1 });
  });

  it("resets expired windows and permits the fifth request within an active IP window", async () => {
    const ipWindow = new Date(now.getTime() - 60_000);
    mockBudgets([
      { key: key("email", "teacher@example.test"), windowStart: new Date(now.getTime() - 60_000), count: 1 },
      { key: key("ip", "198.51.100.1"), windowStart: ipWindow, count: 4 },
    ]);
    await assertVerificationSendAllowed("teacher@example.test", "198.51.100.1");
    expect(writes()).toEqual([
      [key("email", "teacher@example.test"), now, 1], [key("ip", "198.51.100.1"), ipWindow, 5],
    ]);
  });

  it("exposes a sanitized HTTP error with a useful retry interval", () => {
    expect(new VerificationSendLimitError(60)).toMatchObject({
      status: 429, code: "TOO_MANY_REQUESTS", retryAfter: 60,
    });
  });
});
