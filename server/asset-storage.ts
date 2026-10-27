import { mkdir, open, readFile, rm } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";

import { getServerConfig } from "./config";
import { HttpError } from "./http-error";

export function resolveStoragePath(key: string): string {
  if (!/^[0-9a-f-]{36}\.(png|jpeg|gif|webp)$/.test(key)) {
    throw new Error("Invalid asset storage key");
  }
  return path.join(getServerConfig().uploadDir, key);
}

export async function storeAsset(key: string, data: Buffer): Promise<void> {
  const filename = resolveStoragePath(key);
  let file: FileHandle | undefined;
  let created = false;
  try {
    await mkdir(getServerConfig().uploadDir, { recursive: true });
    file = await open(filename, "wx", 0o600);
    created = true;
    await file.writeFile(data);
    await file.sync();
    await file.close();
    file = undefined;
    await syncStorageDirectory();
  } catch (error) {
    await file?.close().catch(() => undefined);
    // No database row can exist before this function returns. Only remove our own new file.
    if (created) await rm(filename, { force: true }).catch(() => {
      console.error("Incomplete asset retained for orphan cleanup");
    });
    if (typeof error === "object" && error !== null && "code" in error &&
        (error.code === "ENOSPC" || error.code === "EDQUOT")) {
      throw new HttpError(507, "STORAGE_FULL", "На сервере закончилось место для изображений. Изображение не сохранено.");
    }
    throw error;
  }
}

async function syncStorageDirectory(): Promise<void> {
  // Windows does not expose directory fsync through Node; production uses Linux volumes.
  if (process.platform === "win32") return;
  const directory = await open(getServerConfig().uploadDir, "r");
  try { await directory.sync(); } finally { await directory.close(); }
}

/** Flush imported bytes and their published directory entry before the database commit. */
export async function syncStoredAsset(key: string): Promise<void> {
  const file = await open(resolveStoragePath(key), "r+");
  try { await file.sync(); } finally { await file.close(); }
  await syncStorageDirectory();
}

export async function readStoredAsset(key: string): Promise<Buffer> {
  return readFile(resolveStoragePath(key));
}

export async function removeStoredAsset(key: string): Promise<void> {
  await rm(resolveStoragePath(key), { force: true });
}
