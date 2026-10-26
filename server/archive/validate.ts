import { randomUUID } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";

import sharp from "sharp";
import * as Y from "yjs";

import { validateDocument, validateLegacyDocument } from "../../collaboration-server/document";
import { DEFAULT_LIMITS } from "../../collaboration-server/types";
import { migrateBoardDocument } from "../../lib/board/rich-text/document";
import { getServerConfig } from "../config";
import { HttpError } from "../http-error";

import { invalidArchive, isRecord, parseManifest, verifyFile } from "./format";
import type { ArchiveAsset, ArchiveManifest } from "./format";
import { portableBoard, remapAssets, referencedAssets } from "./portable";
import { extractArchiveEntry, openArchive, readArchiveEntry } from "./zip";

export interface StagedAsset {
  id: string;
  file: string;
  storageKey: string;
  sha256: string;
  bytes: number;
  width: number;
  height: number;
}

export interface ValidatedArchive {
  manifest: ArchiveManifest;
  state: Uint8Array;
  assets: readonly StagedAsset[];
}

async function checkImage(file: string, expected: ArchiveAsset): Promise<void> {
  const config = getServerConfig();
  if (expected.bytes > config.maxUploadBytes || expected.width * expected.height > config.maxImagePixels) throw invalidArchive("Изображение превышает допустимый размер.");
  try {
    const image = sharp(await readFile(file), { limitInputPixels: config.maxImagePixels, failOn: "error" });
    const metadata = await image.metadata();
    if (metadata.format !== "webp" || metadata.width !== expected.width || metadata.height !== expected.height ||
        (metadata.pages ?? 1) !== 1) throw invalidArchive("Параметры изображения не совпадают с архивом.");
    // Decode fully while preserving the exact source bytes; re-encoding WebP would be lossy.
    await image.timeout({ seconds: 10 }).stats();
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "INVALID_ARCHIVE") throw error;
    throw invalidArchive("В архиве есть повреждённое изображение.");
  }
}

export async function validateArchiveFile(filename: string, directory: string, signal: AbortSignal): Promise<ValidatedArchive> {
  const { zip, entries } = await openArchive(filename).catch((error: unknown) => {
    if (error instanceof HttpError) throw error;
    throw invalidArchive();
  });
  const document = new Y.Doc();
  try {
    const manifest = parseManifest(await readArchiveEntry(zip, entries.get("manifest.json")!, signal));
    if (entries.size !== manifest.assets.length + 3) throw invalidArchive("Список файлов не совпадает с содержимым архива.");
    const state = await readArchiveEntry(zip, entries.get("board.yjs")!, signal);
    const portable = await readArchiveEntry(zip, entries.get("board.json")!, signal);
    verifyFile(state, manifest.document);
    verifyFile(portable, manifest.portable);
    let view: unknown;
    try { view = JSON.parse(portable.toString("utf8")); } catch { throw invalidArchive("JSON-представление доски повреждено."); }
    if (!isRecord(view) || view.format !== "rimo-portable-board" ||
        view.version !== (manifest.board.schemaVersion === 1 ? 1 : 2) ||
        view.schemaVersion !== manifest.board.schemaVersion || !Array.isArray(view.layerIds) || !isRecord(view.layers)) throw invalidArchive();
    try { Y.applyUpdate(document, state); } catch { throw invalidArchive("Совместный документ повреждён."); }
    if (document.getMap("meta").get("schemaVersion") !== manifest.board.schemaVersion) throw invalidArchive();
    try {
      if (manifest.board.schemaVersion === 1) validateLegacyDocument(document, DEFAULT_LIMITS);
      else validateDocument(document, DEFAULT_LIMITS);
    } catch { throw invalidArchive("Версия или содержимое доски не поддерживаются."); }
    if (!isDeepStrictEqual(view, JSON.parse(portableBoard(document).toString("utf8")))) {
      throw invalidArchive("JSON-представление не совпадает с совместным документом.");
    }
    const manifestIds = new Set(manifest.assets.map((asset) => asset.id));
    if ([...referencedAssets(document)].some((id) => !manifestIds.has(id))) throw invalidArchive("В архиве не хватает изображения доски.");

    const assets: StagedAsset[] = [];
    const byHash = new Map<string, StagedAsset>();
    const replacements = new Map<string, string>();
    for (const asset of manifest.assets) {
      signal.throwIfAborted();
      const entry = entries.get(asset.path);
      if (!entry) throw invalidArchive("В архиве не хватает изображения.");
      const file = path.join(directory, `asset-${randomUUID()}.webp`);
      await extractArchiveEntry(zip, entry, file, asset, signal);
      const duplicate = byHash.get(asset.sha256);
      if (duplicate) {
        if (duplicate.width !== asset.width || duplicate.height !== asset.height || duplicate.bytes !== asset.bytes) throw invalidArchive();
        replacements.set(asset.id, duplicate.id);
        await rm(file);
        continue;
      }
      await checkImage(file, asset);
      const id = randomUUID();
      const staged: StagedAsset = {
        id, file, storageKey: `${id}.webp`, sha256: asset.sha256, bytes: asset.bytes,
        width: asset.width, height: asset.height,
      };
      assets.push(staged);
      byHash.set(asset.sha256, staged);
      replacements.set(asset.id, id);
    }
    remapAssets(document, replacements);
    // Compare both original representations before applying a one-way schema migration.
    migrateBoardDocument(document);
    signal.throwIfAborted();
    let remapped: Uint8Array;
    try { remapped = validateDocument(document, DEFAULT_LIMITS); } catch { throw invalidArchive("Восстановленная доска превышает ограничения сервиса."); }
    return { manifest, state: remapped, assets };
  } catch (error) {
    if (signal.aborted) throw signal.reason;
    if (error instanceof HttpError) throw error;
    throw invalidArchive();
  } finally {
    zip.close();
    document.destroy();
  }
}
