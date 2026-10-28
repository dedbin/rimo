// @vitest-environment node
import { createHash } from "node:crypto";

import type { Pool } from "pg";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { runMigrations } from "../server/migrations";

const files = vi.hoisted(() => new Map<string, string>());
vi.mock("node:fs/promises", () => ({
  readdir: async () => [...files.keys()],
  readFile: async (filename: string) => {
    const source = files.get(filename.split(/[\\/]/).at(-1)!);
    if (source === undefined) throw new Error("Missing migration fixture");
    return source;
  },
}));

interface AppliedMigration { name: string; checksum: string }

function applied(name: string, source = files.get(name)!): AppliedMigration {
  return { name, checksum: createHash("sha256").update(source.replace(/\r\n/g, "\n")).digest("hex") };
}

function database(history: AppliedMigration[], failedSql?: string) {
  const query = vi.fn(async (sql: string, parameters?: readonly string[]) => {
    if (sql === "SELECT name, checksum FROM schema_migrations") return { rows: history };
    if (sql === "SELECT checksum FROM schema_migrations WHERE name = $1") {
      return { rows: history.filter((entry) => entry.name === parameters?.[0]) };
    }
    if (sql === failedSql) throw new Error("Migration statement failed");
    return { rows: [] };
  });
  const release = vi.fn();
  const pool = { connect: async () => ({ query, release }) } as unknown as Pool;
  return { pool, query, release };
}

function expectNoMigrations(query: ReturnType<typeof database>["query"]): void {
  expect(query.mock.calls.some(([sql]) => sql === "BEGIN" || sql.startsWith("INSERT INTO schema_migrations"))).toBe(false);
  for (const source of files.values()) expect(query).not.toHaveBeenCalledWith(source);
}

beforeEach(() => {
  files.clear();
  // Deliberately unsorted to exercise the filesystem ordering boundary.
  files.set("002-next.sql", "SELECT 'next migration';\n");
  files.set("001-initial.sql", "SELECT 'initial migration';\n");
});

describe("migration history preflight", () => {
  it("applies a clean database in order with one transaction per migration", async () => {
    const context = database([]);
    expect(await runMigrations(context.pool)).toEqual(["001-initial.sql", "002-next.sql"]);
    expect(context.query.mock.calls.filter(([sql]) => ["BEGIN", "COMMIT", ...files.values()].includes(sql)).map(([sql]) => sql))
      .toEqual(["BEGIN", files.get("001-initial.sql"), "COMMIT", "BEGIN", files.get("002-next.sql"), "COMMIT"]);
    expect(context.release).toHaveBeenCalledOnce();
  });

  it("accepts the full applied history without replaying its SQL", async () => {
    const context = database([applied("001-initial.sql"), applied("002-next.sql")]);
    expect(await runMigrations(context.pool)).toEqual([]);
    expectNoMigrations(context.query);
  });

  it("uses the image's filename ordering even when PostgreSQL returns a different order", async () => {
    const context = database([applied("002-next.sql"), applied("001-initial.sql")]);
    expect(await runMigrations(context.pool)).toEqual([]);
    expectNoMigrations(context.query);
  });

  it("permits a later release to append new migrations to a valid prefix", async () => {
    const context = database([applied("001-initial.sql")]);
    files.set("003-new-feature.sql", "SELECT 'new feature';\n");
    expect(await runMigrations(context.pool)).toEqual(["002-next.sql", "003-new-feature.sql"]);
    expect(context.query).not.toHaveBeenCalledWith(files.get("001-initial.sql"));
  });

  it("rejects a database newer than this image before any pending SQL", async () => {
    const context = database([applied("001-initial.sql"), applied("003-future.sql", "SELECT 'future';")]);
    await expect(runMigrations(context.pool)).rejects.toThrow("Applied migration is missing from this image: 003-future.sql");
    expectNoMigrations(context.query);
    expect(context.query).toHaveBeenLastCalledWith("SELECT pg_advisory_unlock(hashtext('rimo-schema-migrations'))");
    expect(context.release).toHaveBeenCalledOnce();
  });

  it("rejects removed historical files even when a newer local migration is pending", async () => {
    const history = [applied("001-initial.sql"), applied("002-next.sql")];
    files.delete("002-next.sql");
    files.set("003-new-feature.sql", "SELECT 'new feature';\n");
    const context = database(history);
    await expect(runMigrations(context.pool)).rejects.toThrow("Applied migration is missing from this image: 002-next.sql");
    expectNoMigrations(context.query);
  });

  it("rejects gaps instead of applying an older missing migration to a newer schema", async () => {
    const context = database([applied("002-next.sql")]);
    await expect(runMigrations(context.pool)).rejects.toThrow("Migration history is not a prefix: 002-next.sql");
    expectNoMigrations(context.query);
  });

  it("checks a later historical checksum before an earlier pending migration can commit", async () => {
    const context = database([applied("002-next.sql", "SELECT 'changed old migration';")]);
    await expect(runMigrations(context.pool)).rejects.toThrow("Migration checksum differs: 002-next.sql");
    expectNoMigrations(context.query);
  });

  it("keeps CRLF and LF equivalent when validating an applied checksum", async () => {
    files.set("001-initial.sql", "SELECT 'initial migration';\r\n");
    const context = database([applied("001-initial.sql", "SELECT 'initial migration';\n")]);
    expect(await runMigrations(context.pool)).toEqual(["002-next.sql"]);
  });

  it("rolls back a failing pending statement and never records or continues past it", async () => {
    const context = database([applied("001-initial.sql")], files.get("002-next.sql"));
    files.set("003-new-feature.sql", "SELECT 'new feature';\n");
    await expect(runMigrations(context.pool)).rejects.toThrow("Migration statement failed");
    expect(context.query).toHaveBeenCalledWith("ROLLBACK");
    expect(context.query.mock.calls.some(([sql]) => sql.startsWith("INSERT INTO schema_migrations"))).toBe(false);
    expect(context.query).not.toHaveBeenCalledWith(files.get("003-new-feature.sql"));
    expect(context.release).toHaveBeenCalledOnce();
  });
});
