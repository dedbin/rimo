// @vitest-environment node
import { randomBytes, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { escapeIdentifier, Pool } from "pg";
import sharp from "sharp";
import * as Y from "yjs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { GET as exportRoute } from "../app/api/boards/[boardId]/archive/route";
import { POST as importRoute } from "../app/api/boards/import/route";
import { initializeDocument } from "../collaboration-server/document";
import { createPostgresRepository } from "../collaboration-server/postgres-repository";
import { getRichTextJson, writeRichTextFragment } from "../lib/board/rich-text/document";
import { plainTextDocument } from "../lib/board/rich-text/validation";
import { downloadAsset, uploadAsset } from "../server/assets";
import { getAuth } from "../server/auth";
import { createBoard } from "../server/boards";
import { getPool } from "../server/db";
import { MAX_ARCHIVE_BYTES, MAX_PORTABLE_BYTES, sha256 } from "../server/archive/format";
import { acquireArchiveJob } from "../server/archive/job";
import { acceptInvite, createInvite } from "../server/invites";
import { runMigrations } from "../server/migrations";
import type { BoardSummary } from "../types/service";

import { nativeArchive } from "./archive-fixtures";
import { verifyFixtureOwner } from "./verified-owner-fixture";

const databaseUrl = process.env.RIMO_TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const suffix = randomUUID().replaceAll("-", "");
const schema = `rimo_archive_test_${suffix}`;
const tempRoot = path.resolve("temp");
const storage = path.join(tempRoot, `archive-assets-${suffix}`);
let admin: Pool;
let ownerId: string;
let ownerCookie: string;
let guestCookie: string;
let otherCookie: string;
let board: BoardSummary;
let sourceAsset: { id: string; bytes: Buffer };
let originalFragment: string;

function request(url: string, body?: BodyInit, cookie = ownerCookie, method = "GET"): Request {
  return new Request(`http://localhost:3000${url}`, {
    method, headers: { origin: "http://localhost:3000", cookie, "content-type": "application/zip" },
    ...(body === undefined ? {} : { body }),
  });
}

function cookies(response: Response): string {
  return response.headers.getSetCookie().map((value) => value.split(";")[0]).join("; ");
}

async function exportBytes(): Promise<Buffer> {
  const response = await exportRoute(request(`/api/boards/${board.id}/archive`), { params: Promise.resolve({ boardId: board.id }) });
  expect(response.status).toBe(200);
  const bytes = Buffer.from(await response.arrayBuffer());
  // Wait for response stream cleanup before starting the next archive job.
  const deadline = Date.now() + 2_000;
  while (true) {
    try { const job = await acquireArchiveJob(); await job.release(); return bytes; }
    catch (error) {
      if (!(error instanceof Error) || !("status" in error) || error.status !== 429 || Date.now() > deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
}

async function boardCount(): Promise<number> {
  return Number((await getPool().query<{ count: string }>("SELECT count(*) AS count FROM boards")).rows[0].count);
}

describe.skipIf(!databaseUrl)("native Rimo archive", () => {
  beforeAll(async () => {
    admin = new Pool({ connectionString: databaseUrl });
    await admin.query(`CREATE SCHEMA ${escapeIdentifier(schema)}`);
    const scoped = new URL(databaseUrl!);
    scoped.searchParams.set("options", `-c search_path=${schema}`);
    process.env.DATABASE_URL = scoped.toString();
    process.env.BETTER_AUTH_SECRET = randomBytes(32).toString("base64url");
    process.env.BETTER_AUTH_URL = "http://localhost:3000";
    process.env.ASSET_STORAGE_PATH = storage;
    await mkdir(storage, { recursive: true });
    await runMigrations();
    const password = randomBytes(24).toString("base64url");
    const provisioner = getAuth({ allowSignUp: true });
    const owner = await provisioner.api.signUpEmail({ body: { name: "Владелец", email: `owner-${suffix}@example.test`, password } });
    ownerId = owner.user.id;
    await verifyFixtureOwner(getPool(), ownerId);
    const login = async (email: string): Promise<string> => cookies(await getAuth().handler(new Request("http://localhost:3000/api/auth/sign-in/email", {
      method: "POST", headers: { origin: "http://localhost:3000", "content-type": "application/json" }, body: JSON.stringify({ email, password }),
    })));
    ownerCookie = await login(`owner-${suffix}@example.test`);
    const otherOwner = await provisioner.api.signUpEmail({ body: { name: "Другой владелец", email: `other-${suffix}@example.test`, password } });
    await verifyFixtureOwner(getPool(), otherOwner.user.id);
    otherCookie = await login(`other-${suffix}@example.test`);
    const guest = await getAuth().handler(new Request("http://localhost:3000/api/auth/sign-in/anonymous", {
      method: "POST", headers: { origin: "http://localhost:3000", "content-type": "application/json" }, body: "{}",
    }));
    guestCookie = cookies(guest);
    const guestUser = await guest.json() as { user: { id: string } };
    board = await createBoard(ownerId, "Урок и домашняя работа");
    const invite = await createInvite(board.id, ownerId, "editor");
    await acceptInvite(guestUser.user.id, invite.token);
    const image = await sharp({ create: { width: 3, height: 2, channels: 4, background: "blue" } }).png().toBuffer();
    const asset = await uploadAsset(board.id, ownerId, image);
    sourceAsset = { id: asset.id, bytes: Buffer.from(await (await downloadAsset(asset.id, ownerId)).arrayBuffer()) };
    const document = new Y.Doc();
    initializeDocument(document);
    document.getMap<Y.Map<unknown>>("layers").set("image", new Y.Map<unknown>([
      ["type", 5], ["x", 10], ["y", 20], ["width", 300], ["height", 200], ["src", asset.url],
    ]));
    document.getMap<Y.Map<unknown>>("layers").set("rich", new Y.Map<unknown>([
      ["type", 2], ["x", 5], ["y", 8], ["width", 400], ["height", 100],
      ["fill", { r: 0, g: 0, b: 0 }], ["fontSize", 16], ["value", "Русский текст x² + y²"],
    ]));
    document.getArray("layerIds").push(["image", "rich"]);
    if (document.getMap("meta").get("schemaVersion") === 2) document.getMap<Y.Map<unknown>>("layers").get("rich")!.delete("value");
    writeRichTextFragment(document.getXmlFragment("text:rich"), { type: "doc", content: [
      { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Уравнение" }] },
      { type: "paragraph", content: [
        { type: "text", text: "Русский текст ", marks: [{ type: "bold" }] },
        { type: "inlineMath", attrs: { latex: "x^2 + y^2" } },
      ] },
      { type: "bulletList", content: [{ type: "listItem", content: [{ type: "paragraph", content: [
        { type: "text", text: "Решение", marks: [{ type: "italic" }] },
      ] }] }] },
      { type: "codeBlock", attrs: { language: "python" }, content: [{ type: "text", text: "print(2 + 2)" }] },
      { type: "blockMath", attrs: { latex: "\\int_0^1 x^2\\,dx = \\frac{1}{3}" } },
    ] });
    writeRichTextFragment(document.getXmlFragment("text:deleted"), plainTextDocument("Удалённый текст для undo"));
    document.getMap("frames").set("lesson", new Y.Map(Object.entries({ name: "Урок", x: 0, y: 0, width: 800, height: 600 })));
    document.getMap("frames").set("homework", new Y.Map(Object.entries({ name: "Домашняя работа", x: 900, y: 0, width: 800, height: 600 })));
    document.getArray("frameIds").push(["homework", "lesson"]);
    originalFragment = document.getXmlFragment("text:rich").toString();
    await createPostgresRepository(getPool()).save(board.id, Y.encodeStateAsUpdate(document));
    document.destroy();
  }, 30_000);

  afterAll(async () => {
    if (databaseUrl) await getPool().end();
    if (admin) {
      if (!/^rimo_archive_test_[a-f0-9]{32}$/.test(schema)) throw new Error("Unexpected test schema");
      await admin.query(`DROP SCHEMA IF EXISTS ${escapeIdentifier(schema)} CASCADE`);
      await admin.end();
    }
    if (path.dirname(storage) !== tempRoot) throw new Error("Unexpected test cleanup directory");
    await rm(storage, { recursive: true, force: true });
  });

  it("restores full Yjs, exact image bytes and fresh asset IDs into a new owner board", async () => {
    const archive = await exportBytes();
    const restored = await importRoute(request("/api/boards/import", new Uint8Array(archive), ownerCookie, "POST"));
    expect(restored.status).toBe(201);
    const result = await restored.json() as { board: BoardSummary };
    expect(result.board.id).not.toBe(board.id);
    expect(result.board.ownerId).toBe(ownerId);
    const row = (await getPool().query<{ state: Buffer }>("SELECT state FROM board_documents WHERE board_id = $1", [result.board.id])).rows[0];
    const document = new Y.Doc();
    Y.applyUpdate(document, row.state);
    expect(document.getMap("meta").get("schemaVersion")).toBe(2);
    expect(document.getXmlFragment("text:rich").toString()).toBe(originalFragment);
    expect(getRichTextJson(document, "rich").content.at(-1)).toEqual({ type: "blockMath", attrs: { latex: "\\int_0^1 x^2\\,dx = \\frac{1}{3}" } });
    expect(getRichTextJson(document, "deleted")).toEqual(plainTextDocument("Удалённый текст для undo"));
    expect(document.getArray("layerIds").toArray()).toEqual(["image", "rich"]);
    expect(document.getArray("frameIds").toArray()).toEqual(["homework", "lesson"]);
    expect(document.getMap<Y.Map<unknown>>("frames").get("homework")!.get("name")).toBe("Домашняя работа");
    const image = document.getMap<Y.Map<unknown>>("layers").get("image")!;
    expect(image.get("src")).not.toBe(`/api/assets/${sourceAsset.id}`);
    const id = String(image.get("src")).split("/").at(-1)!;
    const bytes = Buffer.from(await (await downloadAsset(id, ownerId)).arrayBuffer());
    expect(sha256(bytes)).toBe(sha256(sourceAsset.bytes));
    expect((await getPool().query("SELECT * FROM board_members WHERE board_id = $1", [result.board.id])).rowCount).toBe(0);
    document.destroy();
  });

  it("checks legacy portable integrity before migrating plain text to schema 2", async () => {
    const legacyText = "Старое условие задачи\nВторая строка";
    const archive = await nativeArchive({ configure(document) {
      document.getMap("meta").set("schemaVersion", 1);
      document.getMap("layers").set("legacy", new Y.Map<unknown>([
        ["type", 2], ["x", 0], ["y", 0], ["width", 300], ["height", 100],
        ["fill", { r: 0, g: 0, b: 0 }], ["fontSize", 16], ["value", legacyText],
      ]));
      document.getArray("layerIds").push(["legacy"]);
    } });
    const response = await importRoute(request("/api/boards/import", new Uint8Array(archive), ownerCookie, "POST"));
    expect(response.status).toBe(201);
    const { board: imported } = await response.json() as { board: BoardSummary };
    const row = (await getPool().query<{ state: Buffer }>("SELECT state FROM board_documents WHERE board_id = $1", [imported.id])).rows[0];
    const document = new Y.Doc();
    try {
      Y.applyUpdate(document, row.state);
      expect(document.getMap("meta").get("schemaVersion")).toBe(2);
      expect(document.getMap<Y.Map<unknown>>("layers").get("legacy")!.has("value")).toBe(false);
      expect(getRichTextJson(document, "legacy")).toEqual(plainTextDocument(legacyText));
    } finally { document.destroy(); }
  });

  it("restores rich text, LaTeX and files in a fresh database without the original records", async () => {
    const database = `rimo_archive_restore_${suffix}`;
    const targetStorage = path.join(storage, "fresh-database-assets");
    const filename = path.join(storage, "fresh-database.rimo");
    await writeFile(filename, await exportBytes(), { flag: "wx", mode: 0o600 });
    await admin.query(`CREATE DATABASE ${escapeIdentifier(database)}`);
    try {
      const targetUrl = new URL(databaseUrl!);
      targetUrl.pathname = `/${database}`;
      const child = spawn(process.execPath, ["--import=tsx", "__tests__/archive-database-fixture.ts", filename], {
        env: { ...process.env, DATABASE_URL: targetUrl.toString(), ASSET_STORAGE_PATH: targetStorage },
        stdio: ["ignore", "pipe", "pipe"], windowsHide: true, shell: false,
      });
      let output = "";
      let errors = "";
      child.stdout.on("data", (chunk: Buffer) => { output += chunk.toString(); });
      child.stderr.on("data", (chunk: Buffer) => { errors += chunk.toString(); });
      const timer = setTimeout(() => child.kill(), 20_000);
      const code = await new Promise<number | null>((resolve, reject) => {
        child.once("error", reject);
        child.once("close", resolve);
      }).finally(() => clearTimeout(timer));
      expect(code, errors).toBe(0);
      const proof = JSON.parse(output.trim().split(/\r?\n/).at(-1)!);
      expect(proof.schemaVersion).toBe(2);
      expect(proof.ownerId).not.toBe(ownerId);
      expect(proof.assetId).not.toBe(sourceAsset.id);
      expect(proof.imageSha).toBe(sha256(sourceAsset.bytes));
      expect(proof.layerIds).toEqual(["image", "rich"]);
      expect(proof.frameIds).toEqual(["homework", "lesson"]);
      expect(proof.frames.lesson).toEqual({ name: "Урок", x: 0, y: 0, width: 800, height: 600 });
      expect(proof.rich.content.at(-1)).toEqual({ type: "blockMath", attrs: { latex: "\\int_0^1 x^2\\,dx = \\frac{1}{3}" } });
      expect(proof.orphan).toEqual(plainTextDocument("Удалённый текст для undo"));
    } finally {
      if (!/^rimo_archive_restore_[a-f0-9]{32}$/.test(database)) throw new Error("Unexpected archive restore database");
      await admin.query(`DROP DATABASE IF EXISTS ${escapeIdentifier(database)} WITH (FORCE)`);
      await rm(filename, { force: true });
    }
  }, 30_000);

  it("restricts export and restore to a board owner account", async () => {
    const context = { params: Promise.resolve({ boardId: board.id }) };
    expect((await exportRoute(request(`/api/boards/${board.id}/archive`, undefined, otherCookie), context)).status).toBe(404);
    expect((await exportRoute(request(`/api/boards/${board.id}/archive`, undefined, guestCookie), context)).status).toBe(403);
    expect((await importRoute(request("/api/boards/import", "zip", guestCookie, "POST"))).status).toBe(403);
  });

  it("rejects another archive job before reading its request body", async () => {
    const job = await acquireArchiveJob();
    try { expect((await importRoute(request("/api/boards/import", "zip", ownerCookie, "POST"))).status).toBe(429); }
    finally { await job.release(); }
  });

  it("enforces owner asset quota atomically without a partial board", async () => {
    const archive = await exportBytes();
    const before = await boardCount();
    process.env.MAX_OWNER_ASSET_BYTES = String(sourceAsset.bytes.byteLength);
    try {
      const response = await importRoute(request("/api/boards/import", new Uint8Array(archive), ownerCookie, "POST"));
      expect(response.status).toBe(413);
      expect((await response.json()).error.code).toBe("OWNER_ASSET_QUOTA_EXCEEDED");
      expect(await boardCount()).toBe(before);
    } finally { delete process.env.MAX_OWNER_ASSET_BYTES; }
  });

  it("enforces board count and removes published files if document quota rejects the restore", async () => {
    const archive = await exportBytes();
    const before = await boardCount();
    process.env.MAX_BOARDS_PER_OWNER = String(before);
    try {
      expect((await importRoute(request("/api/boards/import", new Uint8Array(archive), ownerCookie, "POST"))).status).toBe(409);
      expect(await boardCount()).toBe(before);
    } finally { delete process.env.MAX_BOARDS_PER_OWNER; }
    const files = (await readdir(storage)).filter((file) => file.endsWith(".webp")).sort();
    const usage = await getPool().query<{ bytes: string }>("SELECT sum(octet_length(state)) AS bytes FROM board_documents");
    process.env.MAX_GLOBAL_DOCUMENT_BYTES = usage.rows[0].bytes;
    try {
      const response = await importRoute(request("/api/boards/import", new Uint8Array(archive), ownerCookie, "POST"));
      expect(response.status).toBe(413);
      expect((await response.json()).error.code).toBe("GLOBAL_DOCUMENT_QUOTA_EXCEEDED");
      expect(await boardCount()).toBe(before);
      expect((await readdir(storage)).filter((file) => file.endsWith(".webp")).sort()).toEqual(files);
    } finally { delete process.env.MAX_GLOBAL_DOCUMENT_BYTES; }
  });

  it.each([
    ["invalid image", () => nativeArchive({ asset: Buffer.from("<svg onload=evil()></svg>") })],
    ["bad checksum", () => nativeArchive({ corruptHash: true })],
    ["duplicate entries", () => nativeArchive({ duplicate: true })],
    ["unexpected file", () => nativeArchive({ extra: { path: "session.json", data: Buffer.from("{}") } })],
    ["different JSON and Yjs contents", () => nativeArchive({ mismatchedView: true })],
    ["unsupported legacy shared root", () => nativeArchive({ configure(document) {
      document.getMap("meta").set("schemaVersion", 1);
      document.getMap("unsupported").set("payload", "unexpected");
    } })],
    ["legacy text exceeding the rich-text node budget", () => nativeArchive({ configure(document) {
      document.getMap("meta").set("schemaVersion", 1);
      document.getMap("layers").set("largeText", new Y.Map<unknown>([
        ["type", 2], ["x", 0], ["y", 0], ["width", 300], ["height", 100],
        ["fill", { r: 0, g: 0, b: 0 }], ["fontSize", 16], ["value", "Строка\n".repeat(3_000)],
      ]));
      document.getArray("layerIds").push(["largeText"]);
    } })],
  ])("rejects %s before creating any board", async (_name, makeArchive) => {
    const before = await boardCount();
    const archive = await makeArchive();
    const response = await importRoute(request("/api/boards/import", new Uint8Array(archive), ownerCookie, "POST"));
    expect(response.status).toBe(400);
    expect(await boardCount()).toBe(before);
  });

  it("rejects a compressed oversized entry before expanding it", async () => {
    const archive = await nativeArchive({ portable: Buffer.alloc(MAX_PORTABLE_BYTES + 1, "x") });
    expect(archive.byteLength).toBeLessThan(100_000);
    expect((await importRoute(request("/api/boards/import", new Uint8Array(archive), ownerCookie, "POST"))).status).toBe(400);
  });

  it("rejects oversized declared uploads and cleans temporary files", async () => {
    const response = await importRoute(new Request("http://localhost:3000/api/boards/import", {
      method: "POST", headers: { origin: "http://localhost:3000", cookie: ownerCookie, "content-type": "application/zip", "content-length": String(MAX_ARCHIVE_BYTES + 1) }, body: "zip",
    }));
    expect(response.status).toBe(413);
    expect(await readdir(path.join(storage, ".archive-work"))).toEqual([]);
  });

  it("rejects a malformed ZIP as a client error", async () => {
    expect((await importRoute(request("/api/boards/import", "not a ZIP", ownerCookie, "POST"))).status).toBe(400);
  });

  it("rejects path traversal without writing outside the workspace", async () => {
    const name = "safe-name.txt";
    const malicious = "../escape.txt";
    const archive = await nativeArchive({ extra: { path: name, data: Buffer.from("unsafe") } });
    const source = Buffer.from(name);
    let offset = archive.indexOf(source);
    while (offset !== -1) { archive.set(Buffer.from(malicious), offset); offset = archive.indexOf(source, offset + source.byteLength); }
    expect((await importRoute(request("/api/boards/import", new Uint8Array(archive), ownerCookie, "POST"))).status).toBe(400);
    expect(await readdir(path.join(storage, ".archive-work"))).toEqual([]);
    expect(await readdir(storage)).not.toContain("escape.txt");
  });

  it("counts actual streamed upload bytes when Content-Length is absent", async () => {
    const chunk = new Uint8Array(1024 * 1024);
    let sent = 0;
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        sent += chunk.byteLength;
        controller.enqueue(chunk);
      },
      cancel() { cancelled = true; },
    });
    const init: RequestInit & { duplex: "half" } = {
      method: "POST", headers: { origin: "http://localhost:3000", cookie: ownerCookie, "content-type": "application/zip" }, body, duplex: "half",
    };
    expect((await importRoute(new Request("http://localhost:3000/api/boards/import", init))).status).toBe(413);
    expect(cancelled).toBe(true);
    expect(sent).toBeGreaterThan(MAX_ARCHIVE_BYTES);
    expect(await readdir(path.join(storage, ".archive-work"))).toEqual([]);
  }, 15_000);
});
