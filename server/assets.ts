import { createHash, randomUUID } from "node:crypto";

import sharp from "sharp";

import type { AssetSummary } from "../types/service";
import { isUuid, requireBoardAccess } from "./access";
import { createAssetDownloadResponse, type AssetDownloadOptions } from "./asset-download";
import { storeAsset } from "./asset-storage";
import { getServerConfig } from "./config";
import { getPool, inTransaction } from "./db";
import { HttpError } from "./http-error";
import { assertAssetQuota } from "./quotas";

interface AssetRow {
  id: string;
  board_id: string;
  storage_key: string;
  mime_type: string;
  byte_size: string;
  width: number;
  height: number;
}

function summarize(row: AssetRow): AssetSummary {
  return {
    id: row.id,
    url: `/api/assets/${row.id}`,
    mimeType: row.mime_type,
    width: row.width,
    height: row.height,
    size: Number(row.byte_size),
  };
}

export async function normalizeImage(bytes: Buffer): Promise<{ data: Buffer; width: number; height: number }> {
  const config = getServerConfig();
  if (!bytes.length || bytes.length > config.maxUploadBytes) {
    throw new HttpError(413, "FILE_TOO_LARGE", "Превышен допустимый размер изображения.");
  }
  try {
    const image = sharp(bytes, { limitInputPixels: config.maxImagePixels, failOn: "error" });
    const metadata = await image.metadata();
    if (!metadata.format || !["jpeg", "png", "webp", "gif"].includes(metadata.format)) {
      throw new Error("Unsupported image format");
    }
    const { data, info } = await image.rotate().webp({ quality: 90 }).toBuffer({ resolveWithObject: true });
    if (data.length > config.maxUploadBytes) {
      throw new HttpError(413, "FILE_TOO_LARGE", "Превышен допустимый размер изображения.");
    }
    return { data, width: info.width, height: info.height };
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(400, "INVALID_IMAGE", "Нужен корректный файл JPEG, PNG, WebP или GIF.");
  }
}

let activeUploads = 0;

export async function withAssetUpload<T>(operation: () => Promise<T>): Promise<T> {
  if (activeUploads >= 2) {
    throw new HttpError(429, "UPLOAD_BUSY", "Изображения обрабатываются. Повторите немного позже.");
  }
  activeUploads += 1;
  try {
    return await operation();
  } finally {
    activeUploads -= 1;
  }
}

export async function uploadAsset(boardId: string, userId: string, bytes: Buffer): Promise<AssetSummary> {
  await requireBoardAccess(boardId, userId, "edit");
  const normalized = await normalizeImage(bytes);
  const sha256 = createHash("sha256").update(normalized.data).digest("hex");
  const id = randomUUID();
  const storageKey = `${id}.webp`;
  let fileWritten = false;
  try {
    return await inTransaction(async (client) => {
      const board = await client.query<{ owner_id: string }>(
        "SELECT owner_id FROM boards WHERE id = $1 FOR UPDATE", [boardId],
      );
      if (!board.rows.length) throw new HttpError(404, "BOARD_NOT_FOUND", "Доска недоступна.");
      const existing = await client.query<AssetRow>(
        "SELECT * FROM assets WHERE board_id = $1 AND sha256 = $2", [boardId, sha256],
      );
      if (existing.rows[0]) return summarize(existing.rows[0]);
      await assertAssetQuota(client, {
        boardId, ownerId: board.rows[0].owner_id, additionalBytes: normalized.data.length,
      });
      await storeAsset(storageKey, normalized.data);
      fileWritten = true;
      const inserted = await client.query<AssetRow>(
        `INSERT INTO assets(id, board_id, uploaded_by, storage_key, sha256, mime_type, byte_size, width, height)
         VALUES ($1, $2, $3, $4, $5, 'image/webp', $6, $7, $8) RETURNING *`,
        [id, boardId, userId, storageKey, sha256, normalized.data.length, normalized.width, normalized.height],
      );
      return summarize(inserted.rows[0]);
    });
  } catch (error) {
    if (fileWritten) {
      // A failed COMMIT response may still mean the row was committed.
      // Keep the file so a connection failure cannot destroy a durable asset.
      console.error("Asset upload transaction failed; retained file for recovery", { assetId: id });
    }
    throw error;
  }
}

export async function downloadAsset(
  assetId: string, userId: string, options: AssetDownloadOptions = {},
): Promise<Response> {
  if (!isUuid(assetId)) throw new HttpError(404, "ASSET_NOT_FOUND", "Изображение недоступно.");
  const result = await getPool().query<AssetRow>("SELECT * FROM assets WHERE id = $1", [assetId]);
  const asset = result.rows[0];
  if (!asset) throw new HttpError(404, "ASSET_NOT_FOUND", "Изображение недоступно.");
  await requireBoardAccess(asset.board_id, userId);
  return createAssetDownloadResponse({
    id: asset.id, storageKey: asset.storage_key, mimeType: asset.mime_type, byteSize: Number(asset.byte_size),
  }, options);
}
