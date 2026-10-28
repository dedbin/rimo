import type { PoolClient } from "pg";

import { getPool } from "../db";
import { HttpError } from "../http-error";

export interface ArchiveJob {
  client: PoolClient;
  signal: AbortSignal;
  release(): Promise<void>;
}

export async function acquireArchiveJob(): Promise<ArchiveJob> {
  const client = await getPool().connect();
  const controller = new AbortController();
  let released = false;
  const failed = (): void => controller.abort(new HttpError(503, "ARCHIVE_DATABASE_UNAVAILABLE", "Обработка архива прервана. Повторите позже."));
  client.on("error", failed);
  try {
    const result = await client.query<{ acquired: boolean }>(`SELECT pg_try_advisory_lock(
      hashtext(current_database() || ':' || current_schema()), hashtext('rimo-archive-job')
    ) AS acquired`);
    if (!result.rows[0]?.acquired) throw new HttpError(429, "ARCHIVE_BUSY", "Другой архив уже обрабатывается. Повторите позже.");
  } catch (error) {
    client.off("error", failed);
    client.release(true);
    throw error;
  }
  const deadline = setTimeout(() => controller.abort(new HttpError(408, "ARCHIVE_TIMEOUT", "Обработка архива заняла слишком много времени.")), 120_000);
  deadline.unref();
  return {
    client, signal: controller.signal,
    async release() {
      if (released) return;
      released = true;
      clearTimeout(deadline);
      client.off("error", failed);
      // Closing this dedicated session also releases its advisory lock.
      client.release(true);
    },
  };
}
