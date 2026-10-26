import { Pool, type PoolClient } from "pg";

import { getServerConfig } from "./config";

let pool: Pool | undefined;

export function getPool(): Pool {
  if (!pool) {
    pool = new Pool({
      connectionString: getServerConfig().databaseUrl,
      max: 10,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
      statement_timeout: 15_000,
    });
    pool.on("error", (error: Error) => {
      console.error("PostgreSQL pool error", { name: error.name });
    });
  }
  return pool;
}

export async function inTransaction<T>(
  operation: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const result = await operation(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {
      console.error("PostgreSQL transaction rollback failed");
    }
    throw error;
  } finally {
    client.release();
  }
}
