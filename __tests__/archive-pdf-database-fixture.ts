import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";

import * as Y from "yjs";

import { POST as importRoute } from "../app/api/boards/import/route";
import { POST as downloadRoute } from "../app/api/boards/[boardId]/pdf/route";
import { POST as prepareRoute } from "../app/api/boards/[boardId]/pdf/preview/route";
import { GET as previewRoute } from "../app/api/boards/[boardId]/pdf/preview/[token]/route";
import type { PdfPreview, PdfRequest } from "../export-worker/contract";
import { getRichTextJson } from "../lib/board/rich-text/document";
import { sha256 } from "../server/archive/format";
import { downloadAsset } from "../server/assets";
import { getAuth } from "../server/auth";
import { getPool } from "../server/db";
import { runMigrations } from "../server/migrations";
import type { BoardSummary } from "../types/service";

function request(endpoint: string, cookie: string, body?: unknown): Request {
  return new Request(`http://localhost:3000${endpoint}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { origin: "http://localhost:3000", cookie, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function restoreAndPrint(): Promise<void> {
  await runMigrations();
  const emptyBeforeImport = (await getPool().query(`SELECT
    (SELECT count(*)::int FROM "user") AS users,
    (SELECT count(*)::int FROM boards) AS boards,
    (SELECT count(*)::int FROM board_documents) AS documents,
    (SELECT count(*)::int FROM assets) AS assets`)).rows[0];
  assert.deepEqual(emptyBeforeImport, { users: 0, boards: 0, documents: 0, assets: 0 });
  const password = randomBytes(24).toString("base64url");
  const owner = await getAuth({ allowSignUp: true }).api.signUpEmail({ body: {
    name: "Новый владелец PDF", email: "archive-pdf-restore@example.test", password,
  } });
  const login = await getAuth().handler(request("/api/auth/sign-in/email", "", { email: owner.user.email, password }));
  assert.equal(login.status, 200);
  const cookie = login.headers.getSetCookie().map((value) => value.split(";")[0]).join("; ");
  const bytes = await readFile(process.argv[2]);
  const imported = await importRoute(new Request("http://localhost:3000/api/boards/import", {
    method: "POST", headers: { origin: "http://localhost:3000", cookie, "content-type": "application/zip" }, body: new Uint8Array(bytes),
  }));
  assert.equal(imported.status, 201, await imported.clone().text());
  const { board } = await imported.json() as { board: BoardSummary };
  const row = (await getPool().query<{ state: Buffer; revision: string }>(
    "SELECT state, revision FROM board_documents WHERE board_id = $1", [board.id],
  )).rows[0];
  const document = new Y.Doc();
  try {
    Y.applyUpdate(document, row.state);
    const frameIds = document.getArray<string>("frameIds").toArray();
    const assetId = String(document.getMap<Y.Map<unknown>>("layers").get("image")!.get("src")).split("/").at(-1)!;
    const image = new Uint8Array(await (await downloadAsset(assetId, owner.user.id)).arrayBuffer());
    const input: PdfRequest = { minimumRevision: Number(row.revision), pages: frameIds.map((frameId, index) => ({
      source: { type: "frame", frameId }, format: index === 0 ? "A4" : "A3", orientation: index === 0 ? "portrait" : "landscape",
    })) };
    const context = { params: Promise.resolve({ boardId: board.id }) };
    const prepared = await prepareRoute(request(`/api/boards/${board.id}/pdf/preview`, cookie, input), context);
    assert.equal(prepared.status, 201, await prepared.clone().text());
    const preview = await prepared.json() as PdfPreview;
    assert.deepEqual(preview.warnings, []);
    const htmlResponse = await previewRoute(request(`/api/boards/${board.id}/pdf/preview/${preview.token}?page=1`, cookie), {
      params: Promise.resolve({ boardId: board.id, token: preview.token }),
    });
    assert.equal(htmlResponse.status, 200);
    const html = await htmlResponse.text();
    const downloaded = await downloadRoute(request(`/api/boards/${board.id}/pdf`, cookie, { token: preview.token, acceptWarnings: false }), context);
    assert.equal(downloaded.status, 200);
    const pdf = Buffer.from(await downloaded.arrayBuffer());
    assert.equal(pdf.toString("ascii", 0, 5), "%PDF-");
    await writeFile(process.argv[3], pdf);
    process.stdout.write(`${JSON.stringify({
      emptyBeforeImport, ownerId: board.ownerId, boardId: board.id, assetId, imageSha256: sha256(image),
      schemaVersion: document.getMap("meta").get("schemaVersion"), rich: getRichTextJson(document, "rich"), frameIds,
      pdfPageNames: preview.pages.map((page) => page.name), restoredRevision: Number(row.revision),
      pdfRevision: Number(downloaded.headers.get("x-rimo-revision")), previewMathRendered: html.includes('class="katex"'),
      previewImageEmbedded: html.includes("data:image/webp;base64,"), pdfBytes: pdf.byteLength,
    })}\n`);
  } finally { document.destroy(); }
}

restoreAndPrint().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : "Archive PDF restore failed"}\n`);
  process.exitCode = 1;
}).finally(() => getPool().end());
