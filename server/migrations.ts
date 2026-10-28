import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

import type { Pool } from "pg";

import { getPool } from "./db";

export async function runMigrations(database: Pool = getPool()): Promise<string[]> {
  const directory = path.join(process.cwd(), "server", "migrations");
  const names = (await readdir(directory)).filter((name) => /^\d+.*\.sql$/.test(name)).sort();
  const migrations = await Promise.all(names.map(async (name) => {
    const sql = (await readFile(path.join(directory, name), "utf8")).replace(/\r\n/g, "\n");
    return { name, sql, checksum: createHash("sha256").update(sql).digest("hex") };
  }));
  const byName = new Map(migrations.map((migration) => [migration.name, migration]));
  const client = await database.connect();
  const applied: string[] = [];
  try {
    await client.query("SELECT pg_advisory_lock(hashtext('rimo-schema-migrations'))");
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now()
    )`);
    const history = await client.query<{ name: string; checksum: string }>(
      "SELECT name, checksum FROM schema_migrations",
    );
    // Use the same filename order as the image, independent of database collation.
    const orderedHistory = history.rows.toSorted((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
    // Check the entire applied prefix before any pending migration can commit.
    for (const [index, entry] of orderedHistory.entries()) {
      const migration = byName.get(entry.name);
      if (!migration) throw new Error(`Applied migration is missing from this image: ${entry.name}`);
      if (migration.checksum !== entry.checksum) throw new Error(`Migration checksum differs: ${entry.name}`);
      if (migrations[index]?.name !== entry.name) throw new Error(`Migration history is not a prefix: ${entry.name}`);
    }
    for (const { name, sql, checksum } of migrations.slice(history.rows.length)) {
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
