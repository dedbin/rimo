import { createWriteStream } from "node:fs";
import { mkdir, mkdtemp, rm, statfs } from "node:fs/promises";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

import { getServerConfig } from "../config";
import { HttpError } from "../http-error";

import { MAX_ARCHIVE_BYTES } from "./format";

export function archiveWorkRoot(): string {
  return path.join(getServerConfig().uploadDir, ".archive-work");
}

export async function createArchiveWorkspace(): Promise<string> {
  const root = archiveWorkRoot();
  await mkdir(root, { recursive: true, mode: 0o700 });
  const disk = await statfs(root);
  if (disk.bavail * disk.bsize < 2 * MAX_ARCHIVE_BYTES + 128 * 1024 * 1024) {
    throw new HttpError(507, "ARCHIVE_DISK_FULL", "Недостаточно свободного места для обработки архива.");
  }
  return mkdtemp(path.join(root, "archive-"));
}

export async function removeArchiveWorkspace(directory: string): Promise<void> {
  const root = path.resolve(archiveWorkRoot());
  const target = path.resolve(directory);
  if (path.dirname(target) !== root || !/^archive-[a-zA-Z0-9_-]+$/.test(path.basename(target))) {
    throw new Error("Refusing to remove an unexpected archive directory");
  }
  await rm(target, { recursive: true, force: true });
}

export function byteLimit(maximum: number, onBytes?: (bytes: number) => void): Transform {
  let total = 0;
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      total += chunk.byteLength;
      try { onBytes?.(chunk.byteLength); } catch (error) {
        callback(error instanceof Error ? error : new Error("Archive byte limit failed"));
        return;
      }
      if (total > maximum) callback(new HttpError(413, "ARCHIVE_TOO_LARGE", "Архив превышает допустимый размер."));
      else callback(null, chunk);
    },
  });
}

export async function spoolArchive(request: Request, target: string, signal: AbortSignal, timeoutMs = 60_000): Promise<void> {
  const length = Number(request.headers.get("content-length") ?? "0");
  if (length > MAX_ARCHIVE_BYTES) throw new HttpError(413, "ARCHIVE_TOO_LARGE", "Архив превышает допустимый размер.");
  if (!request.body) throw new HttpError(400, "ARCHIVE_REQUIRED", "Выберите файл архива Rimo.");
  const timeout = AbortSignal.timeout(timeoutMs);
  try {
    await pipeline(
      Readable.fromWeb(request.body as import("node:stream/web").ReadableStream),
      byteLimit(MAX_ARCHIVE_BYTES),
      createWriteStream(target, { flags: "wx", mode: 0o600 }),
      { signal: AbortSignal.any([signal, request.signal, timeout]) },
    );
  } catch (error) {
    if (timeout.aborted) throw new HttpError(408, "ARCHIVE_UPLOAD_TIMEOUT", "Не удалось загрузить архив вовремя.");
    throw error;
  }
}
