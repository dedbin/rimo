// @vitest-environment node
import { execFile } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { promisify } from "node:util";

import { escapeIdentifier, Pool } from "pg";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as Y from "yjs";

import { GET as exportRoute } from "../app/api/boards/[boardId]/archive/route";
import { initializeDocument } from "../collaboration-server/document";
import { createPostgresRepository } from "../collaboration-server/postgres-repository";
import { createPdfWorker } from "../export-worker/http";
import { getRichTextJson, writeRichTextFragment } from "../lib/board/rich-text/document";
import { plainTextDocument } from "../lib/board/rich-text/validation";
import { sha256 } from "../server/archive/format";
import { downloadAsset, uploadAsset } from "../server/assets";
import { getAuth } from "../server/auth";
import { createBoard } from "../server/boards";
import { getPool } from "../server/db";
import { runMigrations } from "../server/migrations";
import { verifyFixtureOwner } from "./verified-owner-fixture";

const databaseUrl = process.env.RIMO_TEST_DATABASE_URL;
const suffix = randomUUID().replaceAll("-", "");
const schema = `rimo_archive_pdf_${suffix}`;
const targetDatabase = `rimo_archive_pdf_restore_${suffix}`;
const tempRoot = path.resolve("temp");
const directory = path.join(tempRoot, `archive-pdf-${suffix}`);
const storage = path.join(directory, "source-assets");
const workerToken = randomBytes(32).toString("base64url");
const worker = createPdfWorker(workerToken);
const execute = promisify(execFile);
let admin: Pool;

function request(endpoint: string, cookie: string, body?: unknown): Request {
  return new Request(`http://localhost:3000${endpoint}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { origin: "http://localhost:3000", cookie, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

function seed(document: Y.Doc, assetUrl: string): void {
  initializeDocument(document);
  const layers = document.getMap<Y.Map<unknown>>("layers");
  for (const [id, x] of [["rich", 20], ["homework-text", 920]] as const) {
    layers.set(id, new Y.Map<unknown>([
      ["type", 2], ["x", x], ["y", 20], ["width", 600], ["height", 250],
      ["fill", { r: 0, g: 0, b: 0 }], ["fontSize", 20],
    ]));
  }
  layers.set("image", new Y.Map<unknown>([
    ["type", 5], ["x", 20], ["y", 300], ["width", 120], ["height", 80], ["src", assetUrl],
  ]));
  document.getArray("layerIds").push(["rich", "homework-text", "image"]);
  writeRichTextFragment(document.getXmlFragment("text:rich"), { type: "doc", content: [
    { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Уравнение архива" }] },
    { type: "paragraph", content: [{ type: "text", text: "Русский текст после восстановления", marks: [{ type: "bold" }] }] },
    { type: "blockMath", attrs: { latex: "x^2 + y^2 = 25" } },
  ] });
  writeRichTextFragment(document.getXmlFragment("text:homework-text"), plainTextDocument("Домашняя задача после восстановления"));
  document.getMap("frames").set("lesson", new Y.Map(Object.entries({ name: "Урок", x: 0, y: 0, width: 700, height: 500 })));
  document.getMap("frames").set("homework", new Y.Map(Object.entries({ name: "Домашняя работа", x: 900, y: 0, width: 700, height: 500 })));
  // The saved order intentionally differs from left-to-right spatial order.
  document.getArray("frameIds").push(["homework", "lesson"]);
}

describe.skipIf(!databaseUrl || process.env.RIMO_PDF_BROWSER_TEST !== "1")("archive PDF on a new database", () => {
  beforeAll(async () => {
    admin = new Pool({ connectionString: databaseUrl });
    await admin.query(`CREATE SCHEMA ${escapeIdentifier(schema)}`);
    const scoped = new URL(databaseUrl!);
    scoped.searchParams.set("options", `-c search_path=${schema}`);
    process.env.DATABASE_URL = scoped.toString();
    process.env.BETTER_AUTH_SECRET = randomBytes(32).toString("base64url");
    process.env.BETTER_AUTH_URL = "http://localhost:3000";
    process.env.ASSET_STORAGE_PATH = storage;
    process.env.PDF_WORKER_TOKEN = workerToken;
    await mkdir(storage, { recursive: true });
    await runMigrations();
    await new Promise<void>((resolve) => worker.listen(0, "127.0.0.1", resolve));
    process.env.PDF_WORKER_URL = `http://127.0.0.1:${(worker.address() as AddressInfo).port}`;
  }, 30_000);

  afterAll(async () => {
    worker.closeAllConnections();
    if (worker.listening) await new Promise<void>((resolve) => worker.close(() => resolve()));
    if (databaseUrl && process.env.RIMO_PDF_BROWSER_TEST === "1") await getPool().end();
    if (admin) {
      if (!/^rimo_archive_pdf_[a-f0-9]{32}$/.test(schema)) throw new Error("Unexpected archive PDF schema");
      if (!/^rimo_archive_pdf_restore_[a-f0-9]{32}$/.test(targetDatabase)) throw new Error("Unexpected archive PDF database");
      await admin.query(`DROP DATABASE IF EXISTS ${escapeIdentifier(targetDatabase)} WITH (FORCE)`);
      await admin.query(`DROP SCHEMA IF EXISTS ${escapeIdentifier(schema)} CASCADE`);
      await admin.end();
    }
    if (path.dirname(directory) !== tempRoot) throw new Error("Unexpected archive PDF directory");
    await rm(directory, { recursive: true, force: true });
  });

  it("prints restored rich text, math, image and saved frame order without the source database", async () => {
    const password = randomBytes(24).toString("base64url");
    const owner = await getAuth({ allowSignUp: true }).api.signUpEmail({ body: {
      name: "Владелец переносимого PDF", email: `archive-pdf-${suffix}@example.test`, password,
    } });
    await verifyFixtureOwner(getPool(), owner.user.id);
    const login = await getAuth().handler(request("/api/auth/sign-in/email", "", { email: owner.user.email, password }));
    const cookie = login.headers.getSetCookie().map((value) => value.split(";")[0]).join("; ");
    const board = await createBoard(owner.user.id, "Переносимый урок");
    const image = await sharp({ create: { width: 12, height: 8, channels: 4, background: "blue" } }).png().toBuffer();
    const asset = await uploadAsset(board.id, owner.user.id, image);
    const originalImage = new Uint8Array(await (await downloadAsset(asset.id, owner.user.id)).arrayBuffer());
    const document = new Y.Doc();
    let rich: ReturnType<typeof getRichTextJson>;
    try {
      seed(document, asset.url);
      rich = getRichTextJson(document, "rich");
      await createPostgresRepository(getPool()).save(board.id, Y.encodeStateAsUpdate(document));
    } finally { document.destroy(); }
    const exported = await exportRoute(request(`/api/boards/${board.id}/archive`, cookie), { params: Promise.resolve({ boardId: board.id }) });
    expect(exported.status).toBe(200);
    const filename = path.join(directory, "final.rimo");
    await writeFile(filename, Buffer.from(await exported.arrayBuffer()), { mode: 0o600, flag: "wx" });
    // Only the exported archive survives: original records and asset files are removed.
    await admin.query(`DROP SCHEMA ${escapeIdentifier(schema)} CASCADE`);
    if (path.dirname(storage) !== directory || path.dirname(directory) !== tempRoot) throw new Error("Unexpected source asset directory");
    await rm(storage, { recursive: true, force: true });
    await admin.query(`CREATE DATABASE ${escapeIdentifier(targetDatabase)}`);
    const targetUrl = new URL(databaseUrl!);
    targetUrl.pathname = `/${targetDatabase}`;
    targetUrl.searchParams.delete("options");
    const pdfDirectory = path.resolve("temp/pdf-acceptance");
    await mkdir(pdfDirectory, { recursive: true });
    const pdfFilename = path.join(pdfDirectory, "archive-restored-order.pdf");
    const { stdout } = await execute(process.execPath, ["--import=tsx", "__tests__/archive-pdf-database-fixture.ts", filename, pdfFilename], {
      env: { ...process.env, DATABASE_URL: targetUrl.toString(), RIMO_TEST_DATABASE_URL: targetUrl.toString(),
        ASSET_STORAGE_PATH: path.join(directory, "restored-assets"), BETTER_AUTH_SECRET: randomBytes(32).toString("base64url") },
      timeout: 60_000, maxBuffer: 1024 * 1024, windowsHide: true, shell: false,
    });
    const proof = JSON.parse(stdout.trim().split(/\r?\n/).at(-1)!);
    expect(proof.emptyBeforeImport).toEqual({ users: 0, boards: 0, documents: 0, assets: 0 });
    expect(proof.ownerId).not.toBe(owner.user.id);
    expect(proof.boardId).not.toBe(board.id);
    expect(proof.assetId).not.toBe(asset.id);
    expect(proof.imageSha256).toBe(sha256(originalImage));
    expect(proof.schemaVersion).toBe(2);
    expect(proof.rich).toEqual(rich);
    expect(proof.frameIds).toEqual(["homework", "lesson"]);
    expect(proof.pdfPageNames).toEqual(["Домашняя работа", "Урок"]);
    expect(proof.pdfRevision).toBe(proof.restoredRevision);
    expect(proof.previewMathRendered).toBe(true);
    expect(proof.previewImageEmbedded).toBe(true);
    expect(proof.pdfBytes).toBeGreaterThan(1_000);
    await writeFile(path.join(pdfDirectory, "archive-restored-order.json"), JSON.stringify(proof, null, 2));
  }, 90_000);
});
