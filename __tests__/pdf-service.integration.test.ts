// @vitest-environment node
import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import type { ClientRequest } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";

import { escapeIdentifier, Pool } from "pg";
import sharp from "sharp";
import * as Y from "yjs";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { POST as downloadRoute } from "../app/api/boards/[boardId]/pdf/route";
import { POST as prepareRoute } from "../app/api/boards/[boardId]/pdf/preview/route";
import { DELETE as deletePreviewRoute, GET as previewRoute } from "../app/api/boards/[boardId]/pdf/preview/[token]/route";
import { initializeDocument } from "../collaboration-server/document";
import { createPostgresRepository } from "../collaboration-server/postgres-repository";
import type { PdfPreview, PdfRequest } from "../export-worker/contract";
import { createPdfWorker } from "../export-worker/http";
import { writeRichTextFragment } from "../lib/board/rich-text/document";
import { plainTextDocument } from "../lib/board/rich-text/validation";
import { uploadAsset } from "../server/assets";
import { getAuth } from "../server/auth";
import { createBoard } from "../server/boards";
import { getPool } from "../server/db";
import { acceptInvite, createInvite } from "../server/invites";
import { runMigrations } from "../server/migrations";

const databaseUrl = process.env.RIMO_TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const suffix = randomUUID().replaceAll("-", "");
const schema = `rimo_pdf_test_${suffix}`;
const storage = path.resolve("temp", `pdf-assets-${suffix}`);
const token = randomBytes(32).toString("base64url");
const worker = createPdfWorker(token);
let admin: Pool;
let boardId: string;
let ownerCookie: string;
let viewerCookie: string;
let strangerCookie: string;
let viewerId: string;
let committedRevision: number;
let fixed: PdfPreview;
const document = new Y.Doc();

function request(endpoint: string, body?: unknown, cookie = ownerCookie): Request {
  return new Request(`http://localhost:3000${endpoint}`, { method: body === undefined ? "GET" : "POST",
    headers: { origin: "http://localhost:3000", cookie, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}
function context(): { params: Promise<{ boardId: string }> } { return { params: Promise.resolve({ boardId }) }; }
function previewContext(value = fixed.token): { params: Promise<{ boardId: string; token: string }> } { return { params: Promise.resolve({ boardId, token: value }) }; }
function input(minimumRevision = committedRevision, frameId = "lesson"): PdfRequest {
  return { minimumRevision, pages: [{ source: { type: "frame", frameId }, format: "A4", orientation: "portrait" }] };
}
function cookies(response: Response): string { return response.headers.getSetCookie().map((value) => value.split(";")[0]).join("; "); }
function holdWorker(): ClientRequest {
  const connection = httpRequest(`${process.env.PDF_WORKER_URL}/preview?page=0`, { method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" } }, (reply) => reply.resume());
  connection.on("error", () => undefined);
  connection.write("{");
  return connection;
}
async function workerStatus(): Promise<unknown> { return (await fetch(`${process.env.PDF_WORKER_URL}/healthz`)).json(); }

describe.skipIf(!databaseUrl || process.env.RIMO_PDF_BROWSER_TEST !== "1")("committed board PDF HTTP contract", () => {
  beforeAll(async () => {
    admin = new Pool({ connectionString: databaseUrl });
    await admin.query(`CREATE SCHEMA ${escapeIdentifier(schema)}`);
    const scoped = new URL(databaseUrl!);
    scoped.searchParams.set("options", `-c search_path=${schema}`);
    process.env.DATABASE_URL = scoped.toString();
    process.env.BETTER_AUTH_SECRET = randomBytes(32).toString("base64url");
    process.env.BETTER_AUTH_URL = "http://localhost:3000";
    process.env.ASSET_STORAGE_PATH = storage;
    process.env.PDF_WORKER_TOKEN = token;
    await mkdir(storage, { recursive: true });
    await runMigrations();
    await new Promise<void>((resolve) => worker.listen(0, "127.0.0.1", resolve));
    process.env.PDF_WORKER_URL = `http://127.0.0.1:${(worker.address() as AddressInfo).port}`;
    const password = randomBytes(24).toString("base64url");
    const owner = await getAuth({ allowSignUp: true }).api.signUpEmail({ body: { name: "Владелец PDF", email: `pdf-${suffix}@example.test`, password } });
    ownerCookie = cookies(await getAuth().handler(request("/api/auth/sign-in/email", { email: owner.user.email, password }, "")));
    const guest = async (): Promise<{ id: string; cookie: string }> => {
      const response = await getAuth().handler(request("/api/auth/sign-in/anonymous", {}, ""));
      const body = await response.clone().json() as { user: { id: string } };
      return { id: body.user.id, cookie: cookies(response) };
    };
    const viewer = await guest();
    viewerId = viewer.id;
    viewerCookie = viewer.cookie;
    strangerCookie = (await guest()).cookie;
    boardId = (await createBoard(owner.user.id, "Снимок урока")).id;
    const invite = await createInvite(boardId, owner.user.id, "viewer");
    await acceptInvite(viewerId, invite.token);
    const image = await sharp({ create: { width: 12, height: 8, channels: 4, background: "blue" } }).png().toBuffer();
    const asset = await uploadAsset(boardId, owner.user.id, image);
    initializeDocument(document);
    document.getMap("layers").set("text", new Y.Map<unknown>([["type", 2], ["x", 20], ["y", 20], ["width", 400], ["height", 100], ["fontSize", 20], ["fill", { r: 0, g: 0, b: 0 }]]));
    document.getMap("layers").set("image", new Y.Map<unknown>([["type", 5], ["x", 20], ["y", 150], ["width", 120], ["height", 80], ["src", asset.url]]));
    document.getArray("layerIds").push(["image", "text"]);
    document.getMap("frames").set("lesson", new Y.Map<unknown>([["name", "Сохранённый урок"], ["x", 0], ["y", 0], ["width", 500], ["height", 400]]));
    document.getMap("frames").set("narrow", new Y.Map<unknown>([["name", "Узкий фрейм"], ["x", 30], ["y", 30], ["width", 50], ["height", 30]]));
    document.getArray("frameIds").push(["lesson", "narrow"]);
    writeRichTextFragment(document.getXmlFragment("text:text"), plainTextDocument("Сохранённый русский текст"));
    committedRevision = (await createPostgresRepository(getPool()).save(boardId, Y.encodeStateAsUpdate(document))).revision;
  }, 30_000);

  afterAll(async () => {
    document.destroy();
    worker.closeAllConnections();
    if (worker.listening) await new Promise<void>((resolve) => worker.close(() => resolve()));
    if (databaseUrl && process.env.RIMO_PDF_BROWSER_TEST === "1") await getPool().end();
    if (admin) {
      if (!/^rimo_pdf_test_[a-f0-9]{32}$/.test(schema)) throw new Error("Unexpected PDF test schema");
      await admin.query(`DROP SCHEMA IF EXISTS ${escapeIdentifier(schema)} CASCADE`);
      await admin.end();
    }
    if (path.dirname(storage) !== path.resolve("temp")) throw new Error("Unexpected PDF fixture directory");
    await rm(storage, { recursive: true, force: true });
  });

  it("freezes a committed revision and image bytes while editing continues", async () => {
    const prepared = await prepareRoute(request(`/api/boards/${boardId}/pdf/preview`, input()), context());
    expect(prepared.status, await prepared.clone().text()).toBe(201);
    fixed = await prepared.json() as PdfPreview;
    expect(fixed.revision).toBe(committedRevision);
    writeRichTextFragment(document.getXmlFragment("text:text"), plainTextDocument("Новая правка после предпросмотра"));
    await createPostgresRepository(getPool()).save(boardId, Y.encodeStateAsUpdate(document));
    const preview = await previewRoute(request(`/api/boards/${boardId}/pdf/preview/${fixed.token}`), previewContext());
    expect(preview.status).toBe(200);
    const html = await preview.text();
    expect(html).toContain("Сохранённый русский текст");
    expect(html).not.toContain("Новая правка после предпросмотра");
    expect(html).toContain("data:image/webp;base64,");
    expect(preview.headers.get("content-security-policy")).toContain("sandbox");
    expect(preview.headers.get("cache-control")).toBe("private, no-store");
    expect(preview.headers.get("x-content-type-options")).toBe("nosniff");
    expect(preview.headers.get("x-frame-options")).toBe("SAMEORIGIN");
    const downloaded = await downloadRoute(request(`/api/boards/${boardId}/pdf`, { token: fixed.token, acceptWarnings: true }), context());
    expect(downloaded.status).toBe(200);
    expect(downloaded.headers.get("x-rimo-revision")).toBe(String(committedRevision));
    const bytes = Buffer.from(await downloaded.arrayBuffer());
    expect(bytes.toString("ascii", 0, 5)).toBe("%PDF-");
    await mkdir(path.resolve("temp/pdf-acceptance"), { recursive: true });
    await writeFile(path.resolve("temp/pdf-acceptance/fixed-revision.pdf"), bytes);
  }, 30_000);

  it("requires the original user, current board ACL and valid revision on every endpoint", async () => {
    expect((await previewRoute(request(`/api/boards/${boardId}/pdf/preview/${fixed.token}`, undefined, strangerCookie), previewContext())).status).toBe(404);
    expect((await previewRoute(request(`/api/boards/${boardId}/pdf/preview/${fixed.token}`, undefined, viewerCookie), previewContext())).status).toBe(404);
    expect((await downloadRoute(request(`/api/boards/${boardId}/pdf`, { token: fixed.token, acceptWarnings: true }, viewerCookie), context())).status).toBe(404);
    expect((await prepareRoute(request(`/api/boards/${boardId}/pdf/preview`, input(999_999)), context())).status).toBe(409);
    expect((await prepareRoute(request(`/api/boards/${boardId}/pdf/preview`, input(), strangerCookie), context())).status).toBe(404);
    const crossOrigin = request(`/api/boards/${boardId}/pdf/preview`, input());
    crossOrigin.headers.set("origin", "https://other.example.test");
    expect((await prepareRoute(crossOrigin, context())).status).toBe(403);
  });

  it("allows a viewer export but revokes preview and download after membership is revoked", async () => {
    const prepared = await prepareRoute(request(`/api/boards/${boardId}/pdf/preview`, input(), viewerCookie), context());
    expect(prepared.status).toBe(201);
    const value = await prepared.json() as PdfPreview;
    const blocker = holdWorker();
    try {
      await expect.poll(workerStatus).toMatchObject({ running: true, waiting: 0 });
      const pending = previewRoute(request(`/api/boards/${boardId}/pdf/preview/${value.token}`, undefined, viewerCookie), previewContext(value.token));
      await expect.poll(workerStatus).toMatchObject({ running: true, waiting: 1 });
      await getPool().query("UPDATE board_members SET revoked_at = now() WHERE board_id = $1 AND user_id = $2", [boardId, viewerId]);
      blocker.end("}");
      expect((await pending).status).toBe(404);
    } finally { blocker.destroy(); }
    expect((await previewRoute(request(`/api/boards/${boardId}/pdf/preview/${value.token}`, undefined, viewerCookie), previewContext(value.token))).status).toBe(404);
    expect((await downloadRoute(request(`/api/boards/${boardId}/pdf`, { token: value.token, acceptWarnings: true }, viewerCookie), context())).status).toBe(404);
  }, 30_000);

  it("requires explicit acknowledgement of clipping and clears a discarded preview", async () => {
    const prepared = await prepareRoute(request(`/api/boards/${boardId}/pdf/preview`, input(committedRevision, "narrow")), context());
    expect(prepared.status).toBe(201);
    const value = await prepared.json() as PdfPreview;
    expect(value.warnings.some((warning) => warning.code === "CLIPPED_OBJECT")).toBe(true);
    expect((await downloadRoute(request(`/api/boards/${boardId}/pdf`, { token: value.token, acceptWarnings: false }), context())).status).toBe(409);
    const removed = await deletePreviewRoute(new Request(`http://localhost:3000/api/boards/${boardId}/pdf/preview/${value.token}`, { method: "DELETE", headers: { origin: "http://localhost:3000", cookie: ownerCookie } }), previewContext(value.token));
    expect(removed.status).toBe(204);
    expect((await previewRoute(request(`/api/boards/${boardId}/pdf/preview/${value.token}`), previewContext(value.token))).status).toBe(404);
  }, 30_000);

  it("does not deliver HTML if the token expires while its worker request is queued", async () => {
    const prepared = await prepareRoute(request(`/api/boards/${boardId}/pdf/preview`, input()), context());
    expect(prepared.status).toBe(201);
    const value = await prepared.json() as PdfPreview;
    const blocker = holdWorker();
    let clock: ReturnType<typeof vi.spyOn> | undefined;
    try {
      await expect.poll(workerStatus).toMatchObject({ running: true, waiting: 0 });
      const pending = previewRoute(request(`/api/boards/${boardId}/pdf/preview/${value.token}`), previewContext(value.token));
      await expect.poll(workerStatus).toMatchObject({ running: true, waiting: 1 });
      clock = vi.spyOn(Date, "now").mockReturnValue(Date.parse(value.expiresAt) + 1);
      blocker.end("}");
      const expired = await pending;
      expect(expired.status).toBe(404);
      expect(await expired.json()).toMatchObject({ error: { code: "PDF_PREVIEW_EXPIRED" } });
    } finally { clock?.mockRestore(); blocker.destroy(); }
  }, 30_000);

  it("cancels queued preview work and can deliver the same snapshot on a later request", async () => {
    const prepared = await prepareRoute(request(`/api/boards/${boardId}/pdf/preview`, input()), context());
    expect(prepared.status).toBe(201);
    const value = await prepared.json() as PdfPreview;
    const blocker = holdWorker();
    try {
      await expect.poll(workerStatus).toMatchObject({ running: true, waiting: 0 });
      const controller = new AbortController();
      const incoming = new Request(`http://localhost:3000/api/boards/${boardId}/pdf/preview/${value.token}`, { headers: { cookie: ownerCookie }, signal: controller.signal });
      const pending = previewRoute(incoming, previewContext(value.token));
      await expect.poll(workerStatus).toMatchObject({ running: true, waiting: 1 });
      controller.abort();
      expect((await pending).status).toBe(499);
      await expect.poll(workerStatus).toMatchObject({ running: true, waiting: 0 });
      blocker.end("}");
      await expect.poll(workerStatus).toMatchObject({ running: false, waiting: 0 });
      const delivered = await previewRoute(request(`/api/boards/${boardId}/pdf/preview/${value.token}`), previewContext(value.token));
      expect(delivered.status).toBe(200);
      expect(await delivered.text()).toContain("Новая правка после предпросмотра");
    } finally { blocker.destroy(); }
  }, 30_000);
});
