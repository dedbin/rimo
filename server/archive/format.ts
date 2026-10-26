import { createHash } from "node:crypto";

import { HttpError } from "../http-error";

export const ARCHIVE_FORMAT = "rimo-board";
export const ARCHIVE_VERSION = 1;
export const MAX_ARCHIVE_BYTES = 256 * 1024 * 1024;
export const MAX_EXPANDED_BYTES = 256 * 1024 * 1024;
export const MAX_MANIFEST_BYTES = 4 * 1024 * 1024;
export const MAX_PORTABLE_BYTES = 32 * 1024 * 1024;
export const MAX_ARCHIVE_ASSETS = 10_000;
export const MAX_ARCHIVE_ENTRIES = MAX_ARCHIVE_ASSETS + 3;

export interface ArchiveFile {
  path: string;
  bytes: number;
  sha256: string;
}

export interface ArchiveAsset extends ArchiveFile {
  id: string;
  mimeType: "image/webp";
  width: number;
  height: number;
}

export interface ArchiveManifest {
  format: typeof ARCHIVE_FORMAT;
  version: typeof ARCHIVE_VERSION;
  createdAt: string;
  board: { title: string; schemaVersion: number; revision: number };
  document: ArchiveFile;
  portable: ArchiveFile;
  assets: ArchiveAsset[];
}

export function invalidArchive(message = "Архив повреждён или имеет неподдерживаемый формат."): HttpError {
  return new HttpError(400, "INVALID_ARCHIVE", message);
}

export function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function file(value: unknown, expectedPath?: string): ArchiveFile {
  if (!isRecord(value) || typeof value.path !== "string" ||
      (expectedPath && value.path !== expectedPath) || !isPositiveInteger(value.bytes) ||
      value.bytes > MAX_EXPANDED_BYTES || typeof value.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(value.sha256)) {
    throw invalidArchive();
  }
  return { path: value.path, bytes: value.bytes, sha256: value.sha256 };
}

export function parseManifest(bytes: Buffer): ArchiveManifest {
  if (bytes.byteLength > MAX_MANIFEST_BYTES) throw invalidArchive("Слишком большой список содержимого архива.");
  let value: unknown;
  try { value = JSON.parse(bytes.toString("utf8")); } catch { throw invalidArchive(); }
  if (!isRecord(value) || value.format !== ARCHIVE_FORMAT || value.version !== ARCHIVE_VERSION ||
      typeof value.createdAt !== "string" || !Number.isFinite(Date.parse(value.createdAt)) ||
      !isRecord(value.board) || typeof value.board.title !== "string" || !value.board.title.trim() ||
      value.board.title.trim().length > 100 || !isPositiveInteger(value.board.schemaVersion) ||
      typeof value.board.revision !== "number" || !Number.isSafeInteger(value.board.revision) || value.board.revision < 0 ||
      !Array.isArray(value.assets) || value.assets.length > MAX_ARCHIVE_ASSETS) throw invalidArchive();
  const assets = value.assets.map((entry): ArchiveAsset => {
    if (!isRecord(entry) || typeof entry.id !== "string" ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(entry.id) ||
        entry.path !== `assets/${entry.id}.webp` || entry.mimeType !== "image/webp" ||
        !isPositiveInteger(entry.width) || !isPositiveInteger(entry.height)) throw invalidArchive();
    return { ...file(entry), id: entry.id, mimeType: entry.mimeType, width: entry.width, height: entry.height };
  });
  if (new Set(assets.map((asset) => asset.id)).size !== assets.length) throw invalidArchive("В архиве повторяются изображения.");
  return {
    format: ARCHIVE_FORMAT, version: ARCHIVE_VERSION, createdAt: value.createdAt,
    board: { title: value.board.title.trim(), schemaVersion: value.board.schemaVersion, revision: value.board.revision },
    document: file(value.document, "board.yjs"), portable: file(value.portable, "board.json"), assets,
  };
}

export function verifyFile(bytes: Uint8Array, expected: ArchiveFile): void {
  if (bytes.byteLength !== expected.bytes || sha256(bytes) !== expected.sha256) {
    throw invalidArchive("Содержимое архива не прошло проверку целостности.");
  }
}
