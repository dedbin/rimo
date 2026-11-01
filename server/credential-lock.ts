import { Pool } from "pg";
import type { PoolClient } from "pg";

import { getServerConfig } from "./config";
import { HttpError } from "./http-error";

let credentialLockPool: Pool | undefined;

export class CredentialOperationBusyError extends HttpError {
  readonly retryAfter = 1;
  constructor() {
    super(429, "CREDENTIAL_OPERATION_BUSY", "Доступ к аккаунту обновляется. Повторите попытку через несколько секунд.");
  }
}

function getCredentialLockPool(): Pool {
  // Auth's callback uses the main pool; keep lock-only connections separate.
  if (!credentialLockPool) {
    credentialLockPool = new Pool({
      connectionString: getServerConfig().databaseUrl, max: 2, allowExitOnIdle: true,
      idleTimeoutMillis: 1_000, connectionTimeoutMillis: 5_000, statement_timeout: 5_000,
    });
    credentialLockPool.on("error", () => { console.error("Credential lock connection failed"); });
  }
  return credentialLockPool;
}

export async function acquireCredentialLock(client: PoolClient, email: string): Promise<void> {
  const result = await client.query<{ acquired: boolean }>(
    `SELECT pg_try_advisory_xact_lock(
      hashtext(current_database() || ':' || current_schema()), hashtext($1)
    ) AS acquired`, [`rimo-credential:${email.trim().toLowerCase()}`],
  );
  if (!result.rows[0].acquired) {
    throw new CredentialOperationBusyError();
  }
}

export async function withCredentialLock<T>(email: string, operation: () => Promise<T>): Promise<T> {
  const client = await getCredentialLockPool().connect();
  try {
    await client.query("BEGIN");
    await acquireCredentialLock(client, email);
    const value = await operation();
    await client.query("COMMIT");
    return value;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally { client.release(); }
}
