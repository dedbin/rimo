// @vitest-environment node

import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";

import { escapeIdentifier, Pool } from "pg";
import sharp from "sharp";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { createPostgresRepository } from "../collaboration-server/postgres-repository";
import { uploadAsset } from "../server/assets";
import { createOwnerAccount } from "../server/auth";
import { createBoard } from "../server/boards";
import { getQuotaLimits } from "../server/config";
import { getPool } from "../server/db";
import { runMigrations } from "../server/migrations";

const databaseUrl = process.env.RIMO_TEST_DATABASE_URL;
const schema = `rimo_quota_test_${randomUUID().replaceAll("-", "")}`;
const quotedSchema = escapeIdentifier(schema);
const tempRoot = path.resolve(process.cwd(), "temp");
const storagePath = path.join(tempRoot, schema);
const defaults = {
  MAX_OWNERS: "6", MAX_BOARDS_PER_OWNER: "20", MAX_BOARD_ASSET_BYTES: String(200 * 1024 * 1024),
  MAX_OWNER_ASSET_BYTES: String(100 * 1024 * 1024), MAX_GLOBAL_ASSET_BYTES: String(1024 * 1024 * 1024),
  MAX_GLOBAL_DOCUMENT_BYTES: String(500 * 1024 * 1024),
};
let admin: Pool;
let image: Buffer;
let normalizedBytes: number;

async function seedUser(anonymous = false): Promise<string> {
  const id = randomUUID();
  await getPool().query(
    'INSERT INTO "user"(id, name, email, "isAnonymous") VALUES ($1, $2, $3, $4)',
    [id, "Проверка квот", `${id}@example.test`, anonymous],
  );
  return id;
}

async function seedAsset(boardId: string, uploaderId: string, bytes: number): Promise<void> {
  const id = randomUUID();
  await getPool().query(
    `INSERT INTO assets(id, board_id, uploaded_by, storage_key, sha256, mime_type, byte_size, width, height)
     VALUES ($1, $2, $3, $4, $5, 'image/webp', $6, 1, 1)`,
    [id, boardId, uploaderId, `${id}.webp`, id.replaceAll("-", "").repeat(2), bytes],
  );
}

async function writeDocument(boardId: string, bytes: number): Promise<void> {
  await createPostgresRepository(getPool()).save(boardId, new Uint8Array(bytes));
}

describe.skipIf(!databaseUrl)("atomic PostgreSQL service quotas", () => {
  beforeAll(async () => {
    admin = new Pool({ connectionString: databaseUrl });
    await admin.query(`CREATE SCHEMA ${quotedSchema}`);
    const isolatedUrl = new URL(databaseUrl!);
    isolatedUrl.searchParams.set("options", `-c search_path=${schema}`);
    vi.stubEnv("DATABASE_URL", isolatedUrl.toString());
    vi.stubEnv("BETTER_AUTH_SECRET", randomBytes(32).toString("base64url"));
    vi.stubEnv("BETTER_AUTH_URL", "http://localhost:3000");
    vi.stubEnv("ASSET_STORAGE_PATH", storagePath);
    const current = await getPool().query<{ schema: string }>("SELECT current_schema() AS schema");
    if (current.rows[0].schema !== schema) throw new Error("Quota tests require their isolated schema");
    await runMigrations();
    await mkdir(storagePath, { recursive: true });
    image = await sharp({ create: { width: 3, height: 2, channels: 4, background: "red" } }).png().toBuffer();
    normalizedBytes = (await sharp(image).rotate().webp({ quality: 90 }).toBuffer()).length;
  }, 30_000);

  beforeEach(async () => {
    for (const [name, value] of Object.entries(defaults)) vi.stubEnv(name, value);
    await getPool().query(`TRUNCATE ${quotedSchema}.boards, ${quotedSchema}."user" CASCADE`);
  });

  afterAll(async () => {
    await getPool().end();
    if (!/^rimo_quota_test_[a-f0-9]{32}$/.test(schema)) throw new Error("Unexpected quota test schema");
    await admin.query(`DROP SCHEMA IF EXISTS ${quotedSchema} CASCADE`);
    await admin.end();
    const target = path.resolve(storagePath);
    if (!target.startsWith(`${tempRoot}${path.sep}`)) throw new Error("Unsafe quota test cleanup path");
    await rm(target, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });

  it("uses the plan budgets and rejects invalid configuration", () => {
    expect(getQuotaLimits()).toMatchObject({
      maxOwners: 6, maxBoardsPerOwner: 20, maxOwnerAssetBytes: 100 * 1024 * 1024,
      maxGlobalAssetBytes: 1024 * 1024 * 1024, maxGlobalDocumentBytes: 500 * 1024 * 1024,
    });
    for (const name of Object.keys(defaults)) {
      vi.stubEnv(name, "0");
      expect(() => getQuotaLimits()).toThrow(`${name} must be a positive integer`);
      vi.stubEnv(name, defaults[name as keyof typeof defaults]);
    }
    vi.stubEnv("MAX_BOARDS_PER_OWNER", "1.5");
    expect(() => getQuotaLimits()).toThrow("MAX_BOARDS_PER_OWNER");
  });

  it("permits the sixth owner, excludes guests and rejects the seventh", async () => {
    for (let index = 0; index < 5; index += 1) await seedUser();
    for (let index = 0; index < 8; index += 1) await seedUser(true);
    const create = () => createOwnerAccount({
      name: "Владелец", email: `${randomUUID()}@example.test`, password: randomBytes(20).toString("base64url"),
    });
    await create();
    await expect(create()).rejects.toMatchObject({ status: 409, code: "OWNER_LIMIT_REACHED" });
    const count = await getPool().query<{ owners: string; guests: string }>(
      'SELECT count(*) FILTER (WHERE "isAnonymous" = false) AS owners, count(*) FILTER (WHERE "isAnonymous" = true) AS guests FROM "user"',
    );
    expect(count.rows[0]).toEqual({ owners: "6", guests: "8" });
  });

  it("serializes two owner creations competing for the last slot", async () => {
    for (let index = 0; index < 5; index += 1) await seedUser();
    const results = await Promise.allSettled([0, 1].map(() => createOwnerAccount({
      name: "Владелец", email: `${randomUUID()}@example.test`, password: randomBytes(20).toString("base64url"),
    })));
    expect(results.filter((result) => result.status === "fulfilled").length).toBe(1);
    const count = await getPool().query<{ total: string }>('SELECT count(*) AS total FROM "user" WHERE "isAnonymous" = false');
    expect(count.rows[0].total).toBe("6");
  });

  it("permits the twentieth board and rejects concurrent attempts to create a twenty-first", async () => {
    const owner = await seedUser();
    for (let index = 0; index < 19; index += 1) {
      await getPool().query("INSERT INTO boards(id, owner_id, title) VALUES ($1, $2, $3)",
        [randomUUID(), owner, `Доска ${index}`]);
    }
    const results = await Promise.allSettled([createBoard(owner, "Последняя"), createBoard(owner, "Лишняя")]);
    expect(results.filter((result) => result.status === "fulfilled").length).toBe(1);
    const rejected = results.find((result) => result.status === "rejected");
    if (rejected?.status !== "rejected") throw new Error("One board must be rejected by its quota");
    expect(rejected.reason).toMatchObject({ status: 409, code: "BOARD_LIMIT_REACHED" });
    const count = await getPool().query<{ total: string }>("SELECT count(*) AS total FROM boards WHERE owner_id = $1", [owner]);
    expect(count.rows[0].total).toBe("20");
  });

  it("counts guest uploads against the owner across boards and accepts exact capacity", async () => {
    const owner = await seedUser();
    const guest = await seedUser(true);
    const first = await createBoard(owner, "Первая");
    const second = await createBoard(owner, "Вторая");
    await getPool().query("INSERT INTO board_members(board_id, user_id, role) VALUES ($1, $2, 'editor')", [first.id, guest]);
    await seedAsset(first.id, owner, 100 * 1024 * 1024 - normalizedBytes);
    const accepted = await uploadAsset(first.id, guest, image);
    expect(accepted.size).toBe(normalizedBytes);
    await expect(uploadAsset(second.id, owner, image)).rejects.toMatchObject({ code: "OWNER_ASSET_QUOTA_EXCEEDED" });
    expect((await uploadAsset(first.id, guest, image)).id).toBe(accepted.id);
  });

  it("keeps the per-board asset budget as an additional limit", async () => {
    const owner = await seedUser();
    const target = await createBoard(owner, "Лимит доски");
    vi.stubEnv("MAX_BOARD_ASSET_BYTES", String(normalizedBytes - 1));
    await expect(uploadAsset(target.id, owner, image)).rejects.toMatchObject({ code: "ASSET_QUOTA_EXCEEDED" });
  });

  it("accepts the exact global asset budget and blocks growth by another owner", async () => {
    vi.stubEnv("MAX_OWNER_ASSET_BYTES", String(2 * 1024 * 1024 * 1024));
    vi.stubEnv("MAX_BOARD_ASSET_BYTES", String(2 * 1024 * 1024 * 1024));
    const firstOwner = await seedUser();
    const secondOwner = await seedUser();
    const first = await createBoard(firstOwner, "Большая");
    const second = await createBoard(secondOwner, "Последние байты");
    await seedAsset(first.id, firstOwner, 1024 * 1024 * 1024 - normalizedBytes);
    await uploadAsset(second.id, secondOwner, image);
    const third = await createBoard(secondOwner, "Лишние байты");
    await expect(uploadAsset(third.id, secondOwner, image)).rejects.toMatchObject({ code: "GLOBAL_ASSET_QUOTA_EXCEEDED" });
  });

  it("atomically rejects one of two uploads to different boards sharing the last global bytes", async () => {
    vi.stubEnv("MAX_GLOBAL_ASSET_BYTES", String(normalizedBytes));
    const firstOwner = await seedUser();
    const secondOwner = await seedUser();
    const first = await createBoard(firstOwner, "Первая");
    const second = await createBoard(secondOwner, "Вторая");
    await getPool().query(`CREATE FUNCTION ${quotedSchema}.pause_asset_insert() RETURNS trigger
      LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_sleep(0.1); RETURN NEW; END $$`);
    await getPool().query(`CREATE TRIGGER quota_test_pause BEFORE INSERT ON ${quotedSchema}.assets
      FOR EACH ROW EXECUTE FUNCTION ${quotedSchema}.pause_asset_insert()`);
    try {
      const results = await Promise.allSettled([
        uploadAsset(first.id, firstOwner, image), uploadAsset(second.id, secondOwner, image),
      ]);
      expect(results.filter((result) => result.status === "fulfilled").length).toBe(1);
      const usage = await getPool().query<{ total: string }>("SELECT sum(byte_size) AS total FROM assets");
      expect(Number(usage.rows[0].total)).toBe(normalizedBytes);
    } finally {
      await getPool().query(`DROP TRIGGER quota_test_pause ON ${quotedSchema}.assets`);
      await getPool().query(`DROP FUNCTION ${quotedSchema}.pause_asset_insert()`);
    }
  });

  it("counts replacement document bytes and permits shrinking while already over the budget", async () => {
    const owner = await seedUser();
    const first = await createBoard(owner, "Первая");
    const second = await createBoard(owner, "Вторая");
    vi.stubEnv("MAX_GLOBAL_DOCUMENT_BYTES", "100");
    await writeDocument(first.id, 60);
    await writeDocument(second.id, 40);
    await expect(writeDocument(first.id, 61)).rejects.toMatchObject({ code: "GLOBAL_DOCUMENT_QUOTA_EXCEEDED" });
    const unchanged = await getPool().query<{ revision: string; bytes: number }>(
      "SELECT revision, octet_length(state) AS bytes FROM board_documents WHERE board_id = $1", [first.id],
    );
    expect(unchanged.rows[0]).toEqual({ revision: "1", bytes: 60 });
    vi.stubEnv("MAX_GLOBAL_DOCUMENT_BYTES", "50");
    await writeDocument(first.id, 59);
    const usage = await getPool().query<{ total: string }>("SELECT sum(octet_length(state)) AS total FROM board_documents");
    expect(usage.rows[0].total).toBe("99");
  });

  it("serializes document growth on different boards", async () => {
    const owner = await seedUser();
    const first = await createBoard(owner, "Первая");
    const second = await createBoard(owner, "Вторая");
    vi.stubEnv("MAX_GLOBAL_DOCUMENT_BYTES", "100");
    const results = await Promise.allSettled([writeDocument(first.id, 70), writeDocument(second.id, 70)]);
    expect(results.filter((result) => result.status === "fulfilled").length).toBe(1);
    const usage = await getPool().query<{ total: string }>("SELECT sum(octet_length(state)) AS total FROM board_documents");
    expect(usage.rows[0].total).toBe("70");
  });
});
