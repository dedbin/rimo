// @vitest-environment node
import { randomUUID } from "node:crypto";
import { appendFile, lstat, link, mkdir, readFile, rm, symlink, utimes, writeFile } from "node:fs/promises";
import path from "node:path";

import { escapeIdentifier, Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { getQuotaLimits } from "../server/config";
import { runMigrations } from "../server/migrations";
import { pruneOrphanAssets, removeOrphanCandidate } from "../server/operations/prune";
import { collectServiceStatus, serviceStatusExitCode } from "../server/operations/status";
import { MIN_ORPHAN_AGE_MS, openStorageRoot } from "../server/operations/storage";

const databaseUrl = process.env.RIMO_TEST_DATABASE_URL;
const suffix = randomUUID().replaceAll("-", "");
const schema = `rimo_operations_test_${suffix}`;
const temp = path.resolve("temp");
const directory = path.join(temp, `operations-${suffix}`);
const storage = path.join(directory, "storage");
const outside = path.join(directory, "outside");
const owners = [randomUUID(), randomUUID()];
const boards = [randomUUID(), randomUUID(), randomUUID()];
const referenced = [`${randomUUID()}.webp`, `${randomUUID()}.webp`];
let admin: Pool;
let database: Pool;
let now: number;

async function cleanupDirectory(): Promise<void> {
  const target = path.resolve(directory);
  if (!target.startsWith(`${temp}${path.sep}`) || path.basename(target) !== `operations-${suffix}`) throw new Error("Unsafe test cleanup path");
  await rm(target, { recursive: true, force: true });
}
async function insertAsset(key: string, boardId = boards[0], size = 10): Promise<void> {
  await database.query(`INSERT INTO assets(id,board_id,uploaded_by,storage_key,sha256,mime_type,byte_size,width,height)
    VALUES($1,$2,$3,$4,$5,'image/webp',$6,2,2)`,
  [randomUUID(), boardId, owners[0], key, randomUUID().replaceAll("-", "").repeat(2), size]);
}
async function orphan(contents = "orphan"): Promise<string> {
  const key = `${randomUUID()}.webp`;
  await writeFile(path.join(storage, key), contents);
  return key;
}
const prune = (apply = false) => pruneOrphanAssets({ database, uploadDir: storage, now, apply });

describe.skipIf(!databaseUrl)("operator status and conservative physical orphan cleanup", () => {
  beforeAll(async () => {
    admin = new Pool({ connectionString: databaseUrl });
    await admin.query(`CREATE SCHEMA ${escapeIdentifier(schema)}`);
    database = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}`, connectionTimeoutMillis: 2000, statement_timeout: 8000 });
    await runMigrations(database);
    for (const [index, owner] of owners.entries()) await database.query(
      'INSERT INTO "user"(id,name,email) VALUES($1,$2,$3)', [owner, "PRIVATE_PERSON", `private${index}@example.test`],
    );
    await database.query('INSERT INTO "user"(id,name,email,"isAnonymous") VALUES($1,$2,$3,true)', [randomUUID(), "PRIVATE_GUEST", "guest@example.test"]);
    for (const [index, id] of boards.entries()) await database.query("INSERT INTO boards(id,owner_id,title) VALUES($1,$2,$3)",
      [id, owners[index === 2 ? 1 : 0], "PRIVATE_BOARD_TITLE"]);
    await database.query("INSERT INTO board_documents(board_id,state,revision) VALUES($1,$2,1),($3,$4,2)",
      [boards[0], Buffer.from("PRIVATE_CONTENT"), boards[1], Buffer.from([1, 2, 3])]);
  });
  beforeEach(async () => {
    await cleanupDirectory();
    await mkdir(storage, { recursive: true }); await mkdir(outside, { recursive: true });
    await database.query("DELETE FROM assets");
    await insertAsset(referenced[0], boards[0], 10); await insertAsset(referenced[1], boards[2], 20);
    await writeFile(path.join(storage, referenced[0]), "ref"); await writeFile(path.join(storage, referenced[1]), "ref2");
    // Simulate inspection 48 hours later without changing the system clock or ctime.
    now = Date.now() + 2 * MIN_ORPHAN_AGE_MS;
  });
  afterAll(async () => {
    await database?.end();
    if (!/^rimo_operations_test_[a-f0-9]{32}$/.test(schema)) throw new Error("Unsafe test schema");
    if (admin) { await admin.query(`DROP SCHEMA IF EXISTS ${escapeIdentifier(schema)} CASCADE`); await admin.end(); }
    await cleanupDirectory();
  });

  it("reports real aggregate PostgreSQL and filesystem usage without board, person, path or connection data", async () => {
    const report = await collectServiceStatus({ database, uploadDir: storage, quotas: getQuotaLimits() });
    expect(report.database.reachable).toBe(true);
    expect(report.usage).toEqual({ owners: 2, boards: 3, documents: 2, documentBytes: 18, assets: 2, assetBytes: 30,
      maxBoardsPerOwner: 2, maxOwnerAssetBytes: 20, maxBoardAssetBytes: 20 });
    expect(report.storage).toMatchObject({ readable: true, writable: true, regularFileCount: 2, fileBytes: 7 });
    expect(report.storage!.freeBytes).toBeGreaterThan(0);
    const json = JSON.stringify(report);
    for (const privateValue of ["PRIVATE", "example.test", storage, owners[0], boards[0], databaseUrl!]) expect(json).not.toContain(privateValue);
  });

  it("warns about upload limits and becomes critical when the document quota is full", async () => {
    const warning = await collectServiceStatus({ database, uploadDir: storage, quotas: { ...getQuotaLimits(), maxGlobalAssetBytes: 37 } });
    expect(warning.reasonCodes).toContain("GLOBAL_ASSETS_LIMIT_NEAR");
    const uploadsFull = await collectServiceStatus({ database, uploadDir: storage, quotas: { ...getQuotaLimits(), maxGlobalAssetBytes: 30 } });
    expect(uploadsFull.status).toBe("warning"); expect(uploadsFull.reasonCodes).toContain("GLOBAL_ASSETS_LIMIT_REACHED");
    const critical = await collectServiceStatus({ database, uploadDir: storage, quotas: { ...getQuotaLimits(), maxGlobalDocumentBytes: 18 } });
    expect(critical.status).toBe("critical"); expect(critical.reasonCodes).toContain("GLOBAL_DOCUMENTS_LIMIT_REACHED");
    expect(["healthy", "warning", "critical"].map((value) => serviceStatusExitCode(value as "healthy" | "warning" | "critical"))).toEqual([0, 1, 2]);
  });

  it("does not count unfinished registrations as occupied owner slots", async () => {
    const pending = randomUUID();
    try {
      await database.query(
        'INSERT INTO "user"(id,name,email,"registrationPending") VALUES($1,$2,$3,true)',
        [pending, "PRIVATE_PENDING_OWNER", `${pending}@example.test`],
      );
      const report = await collectServiceStatus({ database, uploadDir: storage, quotas: getQuotaLimits() });
      expect(report.usage?.owners).toBe(2);
      expect(report.reasonCodes).not.toContain("OWNERS_LIMIT_REACHED");
    } finally {
      await database.query('DELETE FROM "user" WHERE id = $1', [pending]);
    }
  });

  it("reports a full six-owner pilot as a warning while existing boards remain available", async () => {
    const extra = Array.from({ length: 4 }, () => randomUUID());
    try {
      for (const owner of extra) await database.query('INSERT INTO "user"(id,name,email) VALUES($1,$2,$3)',
        [owner, "PRIVATE_EXTRA_OWNER", `${owner}@example.test`]);
      const report = await collectServiceStatus({ database, uploadDir: storage, quotas: { ...getQuotaLimits(), maxOwners: 6 } });
      expect(report.usage?.owners).toBe(6);
      expect(report.status).toBe("warning");
      expect(report.reasonCodes).toContain("OWNERS_LIMIT_REACHED");
      expect(report.database.reachable).toBe(true);
    } finally { await database.query('DELETE FROM "user" WHERE id = ANY($1::text[])', [extra]); }
  });

  it("defaults to dry-run and preserves even eligible old orphan files and every assets row", async () => {
    const key = await orphan();
    const report = await prune();
    expect(report).toMatchObject({ mode: "dry-run", status: "completed", removedCount: 0 });
    expect(report.candidates).toEqual([{ key, bytes: 6, action: "would-remove" }]);
    expect(await readFile(path.join(storage, key), "utf8")).toBe("orphan");
    expect((await database.query("SELECT count(*) FROM assets")).rows[0].count).toBe("2");
  });

  it("removes only old unreferenced regular files on apply while retaining fresh and referenced files", async () => {
    const old = await orphan(); const fresh = await orphan("fresh");
    await utimes(path.join(storage, fresh), new Date(now), new Date(now));
    const report = await prune(true);
    expect(report).toMatchObject({ status: "completed", removedCount: 1 });
    expect(report.candidates).toEqual([{ key: old, bytes: 6, action: "removed" }]);
    await expect(lstat(path.join(storage, old))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(path.join(storage, fresh), "utf8")).toBe("fresh");
    expect(await readFile(path.join(storage, referenced[0]), "utf8")).toBe("ref");
    expect((await database.query("SELECT count(*) FROM assets")).rows[0].count).toBe("2");
  });

  it("retains freshly created files using the real wall clock", async () => {
    const key = await orphan();
    const report = await pruneOrphanAssets({ database, uploadDir: storage, apply: true });
    expect(report.removedCount).toBe(0); expect(report.candidates).toHaveLength(0);
    expect(await readFile(path.join(storage, key), "utf8")).toBe("orphan");
  });

  it("never traverses directories or links and preserves unknown names and hard links", async () => {
    const foreignKey = `${randomUUID()}.webp`;
    await writeFile(path.join(outside, foreignKey), "foreign");
    await symlink(outside, path.join(storage, "foreign-directory"), process.platform === "win32" ? "junction" : "dir");
    if (process.platform !== "win32") await symlink(path.join(outside, foreignKey), path.join(storage, `${randomUUID()}.webp`), "file");
    const linked = `${randomUUID()}.webp`;
    await link(path.join(outside, foreignKey), path.join(storage, linked));
    await mkdir(path.join(storage, "nested")); await writeFile(path.join(storage, "nested", `${randomUUID()}.webp`), "nested");
    await writeFile(path.join(storage, "PRIVATE_NAME.txt"), "unknown");
    const report = await prune(true);
    expect(report.removedCount).toBe(0); expect(report.skipped.links).toBeGreaterThan(0);
    expect(report.skipped.directories).toBe(1);
    expect(JSON.stringify(report)).not.toContain("PRIVATE_NAME");
    expect(await readFile(path.join(outside, foreignKey), "utf8")).toBe("foreign");
    expect(await readFile(path.join(storage, linked), "utf8")).toBe("foreign");
  });

  it("rejects a symlink upload root and filesystem root before touching foreign files", async () => {
    const alias = path.join(directory, "alias");
    await symlink(storage, alias, process.platform === "win32" ? "junction" : "dir");
    const key = await orphan();
    const report = await pruneOrphanAssets({ database, uploadDir: alias, now, apply: true });
    expect(report).toMatchObject({ status: "aborted", removedCount: 0, reasonCodes: ["STORAGE_ROOT_UNSAFE"] });
    const filesystemRoot = await pruneOrphanAssets({ database, uploadDir: path.parse(storage).root, now, apply: true });
    expect(filesystemRoot.reasonCodes).toEqual(["STORAGE_ROOT_INVALID"]);
    expect(await readFile(path.join(storage, key), "utf8")).toBe("orphan");
  });

  it("rechecks the current DB reference and unchanged file identity immediately before unlink", async () => {
    const key = await orphan(); const root = await openStorageRoot(storage);
    const candidate = { key, identity: await lstat(path.join(storage, key), { bigint: true }) };
    await appendFile(path.join(storage, key), " changed");
    expect(await removeOrphanCandidate(database, root, candidate, now - MIN_ORPHAN_AGE_MS)).toBe("kept-changed");
    const referencedLater = await orphan();
    const later = { key: referencedLater, identity: await lstat(path.join(storage, referencedLater), { bigint: true }) };
    await insertAsset(referencedLater);
    expect(await removeOrphanCandidate(database, root, later, now - MIN_ORPHAN_AGE_MS)).toBe("kept-referenced");
    expect(await readFile(path.join(storage, referencedLater), "utf8")).toBe("orphan");
  });

  it("fails closed on an actual PostgreSQL connection failure without scanning or deleting a file", async () => {
    const key = await orphan(); const url = new URL(databaseUrl!); url.pathname = `/missing_operations_${suffix}`;
    const unavailable = new Pool({ connectionString: url.toString(), connectionTimeoutMillis: 2000 });
    try {
      const report = await pruneOrphanAssets({ database: unavailable, uploadDir: storage, now, apply: true });
      expect(report).toMatchObject({ status: "aborted", removedCount: 0, scannedEntries: 0, reasonCodes: ["DATABASE_CHECK_FAILED"] });
      expect(await readFile(path.join(storage, key), "utf8")).toBe("orphan");
      const status = await collectServiceStatus({ database: unavailable, uploadDir: storage, quotas: getQuotaLimits() });
      expect(status).toMatchObject({ status: "critical", database: { reachable: false }, usage: null });
      expect(JSON.stringify(status)).not.toContain(url.toString());
    } finally { await unavailable.end(); }
  });

  it("stops before unlink when a concurrent asset writer holds the table lock", async () => {
    const key = await orphan(); const writer = await database.connect();
    try {
      await writer.query("BEGIN"); await writer.query("LOCK TABLE assets IN ROW EXCLUSIVE MODE");
      const report = await prune(true);
      expect(report).toMatchObject({ status: "aborted", removedCount: 0, reasonCodes: ["DATABASE_CHECK_FAILED"] });
      expect(await readFile(path.join(storage, key), "utf8")).toBe("orphan");
    } finally { await writer.query("ROLLBACK"); writer.release(); }
  }, 8000);
});
