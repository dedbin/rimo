import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { getServerConfig } from "./config";

export function resolveStoragePath(key: string): string {
  if (!/^[0-9a-f-]{36}\.(png|jpeg|gif|webp)$/.test(key)) {
    throw new Error("Invalid asset storage key");
  }
  return path.join(getServerConfig().uploadDir, key);
}

export async function storeAsset(key: string, data: Buffer): Promise<void> {
  await mkdir(getServerConfig().uploadDir, { recursive: true });
  await writeFile(resolveStoragePath(key), data, { flag: "wx", mode: 0o600 });
}

export async function readStoredAsset(key: string): Promise<Buffer> {
  return readFile(resolveStoragePath(key));
}

export async function removeStoredAsset(key: string): Promise<void> {
  await rm(resolveStoragePath(key), { force: true });
}
