import { constants } from "node:fs";
import { copyFile, link } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { generateCover } from "../../lib/generateCover";
import { removeStoredAsset, resolveStoragePath, syncStoredAsset } from "../asset-storage";
import { getBoardSummary, parseBoardTitle } from "../boards";
import { HttpError } from "../http-error";
import { assertAssetQuota, assertBoardQuota, assertDocumentQuota } from "../quotas";
import type { BoardSummary } from "../../types/service";

import { acquireArchiveJob } from "./job";
import { validateArchiveFile } from "./validate";
import { createArchiveWorkspace, removeArchiveWorkspace, spoolArchive } from "./workspace";

async function publishAsset(source: string, key: string): Promise<void> {
  const destination = resolveStoragePath(key);
  try {
    await link(source, destination);
  } catch (error) {
    const code = typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
    if (!["EXDEV", "EPERM", "ENOTSUP", "EOPNOTSUPP"].includes(String(code))) throw error;
    await copyFile(source, destination, constants.COPYFILE_EXCL);
  }
}

export async function importBoardArchive(request: Request, ownerId: string): Promise<BoardSummary> {
  if (!(request.headers.get("content-type") ?? "").toLowerCase().startsWith("application/zip")) {
    throw new HttpError(400, "INVALID_ARCHIVE_TYPE", "Нужен файл архива Rimo в формате ZIP.");
  }
  const job = await acquireArchiveJob();
  const signal = AbortSignal.any([request.signal, job.signal]);
  let directory: string | undefined;
  let transaction = false;
  let commitAttempted = false;
  const published: string[] = [];
  const id = randomUUID();
  try {
    directory = await createArchiveWorkspace();
    const incoming = path.join(directory, "incoming.zip");
    await spoolArchive(request, incoming, signal);
    const archive = await validateArchiveFile(incoming, directory, signal);
    const title = parseBoardTitle(archive.manifest.board.title);
    await job.client.query("BEGIN");
    transaction = true;
    await assertBoardQuota(job.client, ownerId);
    const { svg } = generateCover();
    const cover = `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
    await job.client.query("INSERT INTO boards(id, owner_id, title, image_url) VALUES ($1, $2, $3, $4)", [id, ownerId, title, cover]);
    await assertAssetQuota(job.client, { boardId: id, ownerId, additionalBytes: archive.assets.reduce((sum, asset) => sum + asset.bytes, 0) });
    for (const asset of archive.assets) {
      signal.throwIfAborted();
      await publishAsset(asset.file, asset.storageKey);
      published.push(asset.storageKey);
      await syncStoredAsset(asset.storageKey);
    }
    if (archive.assets.length) {
      const assets = archive.assets;
      await job.client.query(`INSERT INTO assets(id, board_id, uploaded_by, storage_key, sha256, mime_type, byte_size, width, height)
        SELECT * FROM unnest($1::uuid[], $2::uuid[], $3::text[], $4::text[], $5::text[], $6::text[], $7::bigint[], $8::integer[], $9::integer[])`, [
        assets.map((asset) => asset.id), assets.map(() => id), assets.map(() => ownerId),
        assets.map((asset) => asset.storageKey), assets.map((asset) => asset.sha256), assets.map(() => "image/webp"),
        assets.map((asset) => asset.bytes), assets.map((asset) => asset.width), assets.map((asset) => asset.height),
      ]);
    }
    await assertDocumentQuota(job.client, id, archive.state.byteLength);
    await job.client.query("INSERT INTO board_documents(board_id, state, revision, saved_at) VALUES ($1, $2, 1, now())", [id, Buffer.from(archive.state)]);
    signal.throwIfAborted();
    commitAttempted = true;
    await job.client.query("COMMIT");
    transaction = false;
    return await getBoardSummary(id, ownerId);
  } catch (error) {
    if (transaction) await job.client.query("ROLLBACK").catch(() => undefined);
    if (!commitAttempted) await Promise.allSettled(published.map(removeStoredAsset));
    else console.error("Archive restore outcome may be committed; retained assets", { boardId: id });
    if (job.signal.aborted) throw job.signal.reason;
    throw error;
  } finally {
    if (directory) await removeArchiveWorkspace(directory).catch(() => undefined);
    await job.release();
  }
}
