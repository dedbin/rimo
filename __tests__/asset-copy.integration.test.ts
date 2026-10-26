// @vitest-environment node

import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, readdir, rm } from "node:fs/promises";
import path from "node:path";

import { escapeIdentifier, Pool } from "pg";
import sharp from "sharp";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { POST as copyRoute } from "../app/api/boards/[boardId]/assets/copy/route";
import { copyBoardAssets } from "../server/asset-copy";
import { downloadAsset, uploadAsset } from "../server/assets";
import { getAuth } from "../server/auth";
import { createBoard, deleteBoard } from "../server/boards";
import { getPool } from "../server/db";
import { runMigrations } from "../server/migrations";

const databaseUrl = process.env.RIMO_TEST_DATABASE_URL;
const schema = `rimo_copy_test_${randomUUID().replaceAll("-", "")}`;
const quotedSchema = escapeIdentifier(schema);
const tempRoot = path.resolve("temp");
const storagePath = path.join(tempRoot, schema);
let admin: Pool;
let ownerId: string;
let guestId: string;
let cookie: string;
let red: Buffer;
let blue: Buffer;

async function member(boardId: string, role: "viewer" | "editor"): Promise<void> {
  await getPool().query(
    `INSERT INTO board_members(board_id,user_id,role) VALUES($1,$2,$3)
     ON CONFLICT(board_id,user_id) DO UPDATE SET role=EXCLUDED.role,revoked_at=NULL`, [boardId, guestId, role],
  );
}

async function countAssets(boardId: string): Promise<number> {
  const result = await getPool().query<{ count: string }>("SELECT count(*) FROM assets WHERE board_id=$1", [boardId]);
  return Number(result.rows[0].count);
}

describe.skipIf(!databaseUrl)("copying images between board access boundaries", () => {
  beforeAll(async () => {
    admin = new Pool({ connectionString: databaseUrl });
    await admin.query(`CREATE SCHEMA ${quotedSchema}`);
    const isolatedUrl = new URL(databaseUrl!);
    isolatedUrl.searchParams.set("options", `-c search_path=${schema}`);
    vi.stubEnv("DATABASE_URL", isolatedUrl.toString());
    vi.stubEnv("BETTER_AUTH_SECRET", randomBytes(32).toString("base64url"));
    vi.stubEnv("BETTER_AUTH_URL", "http://localhost:3000");
    vi.stubEnv("ASSET_STORAGE_PATH", storagePath);
    await runMigrations();
    await mkdir(storagePath, { recursive: true });
    const email = `${schema}@example.test`;
    const password = randomBytes(24).toString("base64url");
    ownerId = (await getAuth({ allowSignUp: true }).api.signUpEmail({ body: {
      name: "Владелец проверки", email, password,
    } })).user.id;
    const login = await getAuth().handler(new Request("http://localhost:3000/api/auth/sign-in/email", {
      method: "POST", headers: { "content-type": "application/json", origin: "http://localhost:3000" },
      body: JSON.stringify({ email, password }),
    }));
    expect(login.status).toBe(200);
    cookie = login.headers.getSetCookie().map((value) => value.split(";")[0]).join("; ");
    guestId = randomUUID();
    await getPool().query('INSERT INTO "user"(id,name,email,"isAnonymous") VALUES($1,$2,$3,true)',
      [guestId, "Ученик", `${guestId}@example.test`]);
    red = await sharp({ create: { width: 3, height: 2, channels: 4, background: "red" } }).png().toBuffer();
    blue = await sharp({ create: { width: 3, height: 2, channels: 4, background: "blue" } }).png().toBuffer();
  }, 30_000);

  beforeEach(async () => {
    vi.stubEnv("MAX_BOARD_ASSET_BYTES", String(100 * 1024 * 1024));
    await getPool().query(`TRUNCATE ${quotedSchema}.boards CASCADE`);
  });

  afterAll(async () => {
    await getPool().end();
    if (!/^rimo_copy_test_[a-f0-9]{32}$/.test(schema)) throw new Error("Unexpected test schema");
    await admin.query(`DROP SCHEMA IF EXISTS ${quotedSchema} CASCADE`);
    await admin.end();
    const target = path.resolve(storagePath);
    if (!target.startsWith(`${tempRoot}${path.sep}`)) throw new Error("Unsafe test cleanup path");
    await rm(target, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });

  it("copies exact WebP bytes through HTTP, deduplicates, and survives deletion of the source board", async () => {
    const source = await createBoard(ownerId, "Источник");
    const destination = await createBoard(ownerId, "Получатель");
    const image = await uploadAsset(source.id, ownerId, red);
    const original = new Uint8Array(await (await downloadAsset(image.id, ownerId)).arrayBuffer());
    const response = await copyRoute(new Request(`http://localhost:3000/api/boards/${destination.id}/assets/copy`, {
      method: "POST", headers: { cookie, origin: "http://localhost:3000", "content-type": "application/json" },
      body: JSON.stringify({ assetIds: [image.id, image.id] }),
    }), { params: Promise.resolve({ boardId: destination.id }) });
    expect(response.status).toBe(201);
    const body = await response.json();
    const copiedId = body.assets[image.id].id as string;
    expect(copiedId).not.toBe(image.id);
    expect(await countAssets(destination.id)).toBe(1);
    expect((await copyBoardAssets(destination.id, ownerId, [image.id]))[image.id].id).toBe(copiedId);
    expect((await copyBoardAssets(destination.id, ownerId, [copiedId]))[copiedId].id).toBe(copiedId);
    await member(destination.id, "viewer");
    await deleteBoard(source.id, ownerId);
    expect(new Uint8Array(await (await downloadAsset(copiedId, guestId)).arrayBuffer())).toEqual(original);
  });

  it("requires source visibility and destination editing, including an active membership", async () => {
    const source = await createBoard(ownerId, "Приватный источник");
    const destination = await createBoard(ownerId, "Другая доска");
    const image = await uploadAsset(source.id, ownerId, red);
    await member(destination.id, "editor");
    await expect(copyBoardAssets(destination.id, guestId, [image.id])).rejects.toMatchObject({ status: 404 });
    await member(source.id, "viewer");
    await member(destination.id, "viewer");
    await expect(copyBoardAssets(destination.id, guestId, [image.id])).rejects.toMatchObject({ status: 403 });
    await member(destination.id, "editor");
    await getPool().query("UPDATE board_members SET revoked_at=now() WHERE board_id=$1 AND user_id=$2", [source.id, guestId]);
    await expect(copyBoardAssets(destination.id, guestId, [image.id])).rejects.toMatchObject({ status: 404 });
    expect(await countAssets(destination.id)).toBe(0);
  });

  it("rejects a whole batch at the quota without creating rows or files", async () => {
    const source = await createBoard(ownerId, "Источник квоты");
    const destination = await createBoard(ownerId, "Маленькая доска");
    const first = await uploadAsset(source.id, ownerId, red);
    const second = await uploadAsset(source.id, ownerId, blue);
    const files = await readdir(storagePath);
    vi.stubEnv("MAX_BOARD_ASSET_BYTES", String(first.size + second.size - 1));
    await expect(copyBoardAssets(destination.id, ownerId, [first.id, second.id])).rejects.toMatchObject({ status: 413 });
    expect(await countAssets(destination.id)).toBe(0);
    expect(await readdir(storagePath)).toEqual(files);
  });

  it("serializes simultaneous opposite copies without a lock-order deadlock", async () => {
    const first = await createBoard(ownerId, "Первая");
    const second = await createBoard(ownerId, "Вторая");
    const redAsset = await uploadAsset(first.id, ownerId, red);
    const blueAsset = await uploadAsset(second.id, ownerId, blue);
    await Promise.all([
      copyBoardAssets(first.id, ownerId, [blueAsset.id]), copyBoardAssets(second.id, ownerId, [redAsset.id]),
    ]);
    expect(await countAssets(first.id)).toBe(2);
    expect(await countAssets(second.id)).toBe(2);
  });
});
