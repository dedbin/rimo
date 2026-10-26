import { createReadStream } from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";

import * as Y from "yjs";

import { validateDocument, validateLegacyDocument } from "../../collaboration-server/document";
import { DEFAULT_LIMITS } from "../../collaboration-server/types";
import { requireBoardAccess } from "../access";
import { resolveStoragePath } from "../asset-storage";
import { HttpError } from "../http-error";

import { ARCHIVE_FORMAT, ARCHIVE_VERSION, invalidArchive, MAX_ARCHIVE_ASSETS, MAX_MANIFEST_BYTES, sha256 } from "./format";
import type { ArchiveAsset, ArchiveManifest } from "./format";
import { acquireArchiveJob } from "./job";
import { portableBoard, referencedAssets } from "./portable";
import { createArchiveWorkspace, removeArchiveWorkspace } from "./workspace";
import { buildArchiveZip } from "./zip";
import type { ZipSource } from "./zip";

interface ExportAssetRow {
  id: string; storage_key: string; sha256: string; byte_size: string;
  width: number; height: number; mime_type: string;
}

export async function exportBoardArchive(boardId: string, ownerId: string, signal: AbortSignal, minimumRevision = 0): Promise<Response> {
  await requireBoardAccess(boardId, ownerId, "owner");
  const job = await acquireArchiveJob();
  let directory: string | undefined;
  let transaction = false;
  const combined = AbortSignal.any([signal, job.signal]);
  const dispose = async (): Promise<void> => {
    if (directory) await removeArchiveWorkspace(directory).catch(() => undefined);
    await job.release();
  };
  const document = new Y.Doc();
  try {
    directory = await createArchiveWorkspace();
    await job.client.query("BEGIN");
    transaction = true;
    const board = await job.client.query<{ title: string }>(
      "SELECT title FROM boards WHERE id = $1 AND owner_id = $2 FOR SHARE", [boardId, ownerId],
    );
    if (!board.rows[0]) throw new HttpError(404, "BOARD_NOT_FOUND", "Доска недоступна.");
    const stored = await job.client.query<{ state: Buffer; revision: string }>(
      "SELECT state, revision FROM board_documents WHERE board_id = $1", [boardId],
    );
    const current = stored.rows[0];
    if (!current || Number(current.revision) < minimumRevision) {
      throw new HttpError(409, "BOARD_NOT_SAVED", "Дождитесь сохранения доски и повторите выгрузку.");
    }
    if (current.state.byteLength > DEFAULT_LIMITS.maxDocumentBytes) throw invalidArchive("Доска превышает допустимый размер.");
    Y.applyUpdate(document, current.state);
    if (document.getMap("meta").get("schemaVersion") === 1) validateLegacyDocument(document, DEFAULT_LIMITS);
    else validateDocument(document, DEFAULT_LIMITS);
    const assets = await job.client.query<ExportAssetRow>("SELECT * FROM assets WHERE board_id = $1 ORDER BY id", [boardId]);
    if (assets.rows.length > MAX_ARCHIVE_ASSETS) throw invalidArchive("На доске слишком много изображений для одного архива.");
    const descriptors = assets.rows.map((asset): ArchiveAsset => {
      if (asset.mime_type !== "image/webp") throw invalidArchive("Формат изображения не поддерживается архивом.");
      return {
        id: asset.id, path: `assets/${asset.id}.webp`, bytes: Number(asset.byte_size), sha256: asset.sha256,
        mimeType: "image/webp", width: asset.width, height: asset.height,
      };
    });
    const available = new Set(descriptors.map((asset) => asset.id));
    if ([...referencedAssets(document)].some((id) => !available.has(id))) throw invalidArchive("Не удалось найти все изображения доски.");
    const portable = portableBoard(document);
    const manifest: ArchiveManifest = {
      format: ARCHIVE_FORMAT, version: ARCHIVE_VERSION, createdAt: new Date().toISOString(),
      board: { title: board.rows[0].title, schemaVersion: Number(document.getMap("meta").get("schemaVersion")), revision: Number(current.revision) },
      document: { path: "board.yjs", bytes: current.state.byteLength, sha256: sha256(current.state) },
      portable: { path: "board.json", bytes: portable.byteLength, sha256: sha256(portable) }, assets: descriptors,
    };
    const metadata = Buffer.from(JSON.stringify(manifest), "utf8");
    if (metadata.byteLength > MAX_MANIFEST_BYTES) throw invalidArchive("Список изображений слишком большой.");
    const sources: ZipSource[] = [
      { path: "manifest.json", source: metadata, bytes: metadata.byteLength, sha256: sha256(metadata) },
      { ...manifest.document, source: current.state }, { ...manifest.portable, source: portable },
      ...descriptors.map((asset, index) => ({ ...asset, source: resolveStoragePath(assets.rows[index].storage_key) })),
    ];
    const filename = path.join(directory, "board.rimo");
    const size = await buildArchiveZip(filename, sources, combined);
    // File membership stays stable under the shared board lock, independently of download speed.
    await job.client.query("COMMIT");
    transaction = false;
    const stream = createReadStream(filename, { signal: combined });
    stream.once("close", () => { void dispose(); });
    return new Response(Readable.toWeb(stream, { strategy: { highWaterMark: 65_536, size: (chunk: Uint8Array) => chunk.byteLength } }) as ReadableStream, {
      headers: {
        "Content-Type": "application/zip", "Content-Length": String(size),
        "Content-Disposition": `attachment; filename="rimo-${boardId}-${current.revision}.rimo"`,
        "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    if (transaction) await job.client.query("ROLLBACK").catch(() => undefined);
    await dispose();
    if (job.signal.aborted) throw job.signal.reason;
    throw error;
  } finally {
    document.destroy();
  }
}
