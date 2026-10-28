import { createHash } from "node:crypto";

import { inTransaction } from "./db";
import { HttpError } from "./http-error";

interface SendBudget {
  readonly key: string;
  readonly seconds: number;
  readonly maximum: number;
}

interface BudgetRow {
  readonly key: string;
  readonly windowStart: Date;
  readonly count: number;
}

export class VerificationSendLimitError extends HttpError {
  constructor(readonly retryAfter: number) {
    super(429, "TOO_MANY_REQUESTS", "Слишком много запросов кода. Попробуйте позже.");
    this.name = "VerificationSendLimitError";
  }
}

function budgetKey(kind: "email" | "ip", value: string): string {
  return `${kind}:${createHash("sha256").update(value).digest("hex")}`;
}

export async function assertVerificationSendAllowed(email: string, ip: string): Promise<void> {
  const budgets: readonly SendBudget[] = [
    { key: budgetKey("email", email.trim().toLowerCase()), seconds: 60, maximum: 1 },
    { key: budgetKey("ip", ip.trim()), seconds: 600, maximum: 5 },
  ];
  await inTransaction(async (client) => {
    // A fixed order also serializes requests made by different app instances.
    for (const key of budgets.map((budget) => budget.key).toSorted()) {
      await client.query(
        `SELECT pg_advisory_xact_lock(
          hashtext(current_database() || ':' || current_schema()), hashtext($1)
        )`,
        [`rimo-email-limit:${key}`],
      );
    }
    const clock = await client.query<{ now: Date }>("SELECT clock_timestamp() AS now");
    const now = clock.rows[0].now;
    const existing = await client.query<BudgetRow>(
      'SELECT key, "windowStart", count FROM email_verification_limits WHERE key = ANY($1::text[])',
      [budgets.map((budget) => budget.key)],
    );
    const records = new Map(existing.rows.map((row) => [row.key, row]));
    let retryAfter = 0;
    for (const budget of budgets) {
      const record = records.get(budget.key);
      if (!record || record.count < budget.maximum) continue;
      const remaining = record.windowStart.getTime() + budget.seconds * 1_000 - now.getTime();
      if (remaining > 0) retryAfter = Math.max(retryAfter, Math.ceil(remaining / 1_000));
    }
    if (retryAfter > 0) throw new VerificationSendLimitError(retryAfter);

    // Do not consume either budget until both checks pass.
    for (const budget of budgets) {
      const record = records.get(budget.key);
      const active = record && record.windowStart.getTime() + budget.seconds * 1_000 > now.getTime();
      await client.query(
        `INSERT INTO email_verification_limits(key, "windowStart", count) VALUES ($1, $2, $3)
         ON CONFLICT (key) DO UPDATE SET "windowStart" = EXCLUDED."windowStart", count = EXCLUDED.count`,
        [budget.key, active ? record.windowStart : now, active ? record.count + 1 : 1],
      );
    }
  });
}
