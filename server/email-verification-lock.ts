import { Pool } from "pg";

import { getServerConfig } from "./config";
import { VerificationSendLimitError } from "./email-verification-limits";

let lockPool: Pool | undefined;

function getLockPool(): Pool {
  // Better Auth uses the main pool inside the callback. Separate connections
  // prevent concurrent code requests from exhausting that pool while holding locks.
  if (!lockPool) {
    lockPool = new Pool({
      connectionString: getServerConfig().databaseUrl,
      max: 2,
      allowExitOnIdle: true,
      idleTimeoutMillis: 1_000,
      connectionTimeoutMillis: 5_000,
      statement_timeout: 5_000,
    });
    lockPool.on("error", () => { console.error("Email verification lock connection failed"); });
  }
  return lockPool;
}

export async function withVerificationCodeLock<T>(email: string, operation: () => Promise<T>): Promise<T> {
  const client = await getLockPool().connect();
  try {
    await client.query("BEGIN");
    const result = await client.query<{ acquired: boolean }>(
      `SELECT pg_try_advisory_xact_lock(
        hashtext(current_database() || ':' || current_schema()), hashtext($1)
      ) AS acquired`,
      [`rimo-email-code:${email.trim().toLowerCase()}`],
    );
    if (!result.rows[0].acquired) throw new VerificationSendLimitError(1);
    const value = await operation();
    await client.query("COMMIT");
    return value;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
