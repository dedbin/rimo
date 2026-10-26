import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

import type { Pool } from "pg";

import { getPool } from "./db";

export async function runMigrations(database: Pool = getPool()): Promise<string[]> {
  const directory = path.join(process.cwd(), "server", "migrations");
  const names = (await readdir(directory)).filter((name) => /^\d+.*\.sql$/.test(name)).sort();
  const client = await database.connect();
  const applied: string[] = [];
  try {
    await client.query("SELECT pg_advisory_lock(hashtext('rimo-schema-migrations'))");
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now()
    )`);
    for (const name of names) {
      const sql = (await readFile(path.join(directory, name), "utf8")).replace(/\r\n/g, "\n");
      const checksum = createHash("sha256").update(sql).digest("hex");
      const existing = await client.query<{ checksum: string }>(
        "SELECT checksum FROM schema_migrations WHERE name = $1", [name],
      );
      if (existing.rows.length) {
        if (existing.rows[0].checksum !== checksum) {
          throw new Error(`Migration checksum differs: ${name}`);
        }
        continue;
      }
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query("INSERT INTO schema_migrations(name, checksum) VALUES ($1, $2)", [name, checksum]);
        await client.query("COMMIT");
        applied.push(name);
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    }
    return applied;
  } finally {
    try {
      await client.query("SELECT pg_advisory_unlock(hashtext('rimo-schema-migrations'))");
    } finally {
      client.release();
    }
  }
}
