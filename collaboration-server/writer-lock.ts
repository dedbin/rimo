import type { Pool } from "pg";

import { withDeadline } from "./deadline";

const LOCK_QUERY = `SELECT pg_try_advisory_lock(
  hashtext(current_database()),
  hashtext(current_schema() || ':rimo-collaboration-writer')
) AS acquired`;
const UNLOCK_QUERY = `SELECT pg_advisory_unlock(
  hashtext(current_database()),
  hashtext(current_schema() || ':rimo-collaboration-writer')
)`;

export class WriterAlreadyRunningError extends Error {
  constructor() {
    super("Another collaboration writer is already running for this database and schema");
  }
}

export async function acquireWriterLock(pool: Pool, onLost: () => void): Promise<() => Promise<void>> {
  const client = await pool.connect();
  let released = false;
  let failed = false;
  let checking = false;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  const lost = (): void => {
    if (released || failed) return;
    failed = true;
    if (heartbeat) clearInterval(heartbeat);
    heartbeat = undefined;
    onLost();
  };
  client.on("error", lost);
  client.on("end", lost);
  try {
    const result = await withDeadline(client.query<{ acquired: boolean }>(LOCK_QUERY), 3_000);
    if (!result.rows[0]?.acquired) throw new WriterAlreadyRunningError();
  } catch (error) {
    released = true;
    if (heartbeat) clearInterval(heartbeat);
    heartbeat = undefined;
    client.off("error", lost);
    client.off("end", lost);
    client.release(true);
    throw error;
  }
  heartbeat = setInterval(() => {
    if (checking || released || failed) return;
    checking = true;
    void withDeadline(client.query("SELECT 1"), 3_000)
      .catch(lost)
      .finally(() => { checking = false; });
  }, 5_000);
  heartbeat.unref();

  return async (): Promise<void> => {
    if (released) return;
    released = true;
    if (heartbeat) clearInterval(heartbeat);
    heartbeat = undefined;
    try {
      if (!failed) await withDeadline(client.query(UNLOCK_QUERY), 3_000);
    } finally {
      client.off("error", lost);
      client.off("end", lost);
      client.release(true);
    }
  };
}
