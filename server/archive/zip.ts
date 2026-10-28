import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { stat } from "node:fs/promises";
import { addAbortSignal, Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

import * as yauzl from "yauzl";
import { ZipFile } from "yazl";

import { DEFAULT_LIMITS } from "../../collaboration-server/types";
import { getServerConfig } from "../config";

import {
  invalidArchive, MAX_ARCHIVE_BYTES, MAX_ARCHIVE_ENTRIES, MAX_EXPANDED_BYTES,
  MAX_MANIFEST_BYTES, MAX_PORTABLE_BYTES,
} from "./format";
import type { ArchiveFile } from "./format";
import { byteLimit } from "./workspace";

export interface ZipSource extends ArchiveFile {
  source: string | Buffer;
}

function entryLimit(name: string): number {
  if (name === "manifest.json") return MAX_MANIFEST_BYTES;
  if (name === "board.yjs") return DEFAULT_LIMITS.maxDocumentBytes;
  if (name === "board.json") return MAX_PORTABLE_BYTES;
  if (/^assets\/[a-f0-9-]{36}\.webp$/.test(name)) return getServerConfig().maxUploadBytes;
  throw invalidArchive("В архиве есть посторонний файл.");
}

export async function openArchive(path: string): Promise<{ zip: yauzl.ZipFile; entries: ReadonlyMap<string, yauzl.Entry> }> {
  if ((await stat(path)).size > MAX_ARCHIVE_BYTES) throw invalidArchive("Архив слишком большой.");
  const zip = await yauzl.openPromise(path, { lazyEntries: true, strictFileNames: true, validateEntrySizes: true, autoClose: false });
  try {
    if (zip.entryCount > MAX_ARCHIVE_ENTRIES) throw invalidArchive("В архиве слишком много файлов.");
    const entries = new Map<string, yauzl.Entry>();
    let expanded = 0;
    for await (const entry of zip.eachEntry()) {
      const limit = entryLimit(entry.fileName);
      const type = (entry.externalFileAttributes >>> 16) & 0o170000;
      if (entries.has(entry.fileName) || entry.isEncrypted() || !entry.canDecodeFileData() ||
          (type !== 0 && type !== 0o100000) || !Number.isSafeInteger(entry.uncompressedSize) ||
          entry.uncompressedSize <= 0 || entry.uncompressedSize > limit) throw invalidArchive();
      expanded += entry.uncompressedSize;
      if (expanded > MAX_EXPANDED_BYTES) throw invalidArchive("Распакованное содержимое архива слишком большое.");
      entries.set(entry.fileName, entry);
    }
    for (const required of ["manifest.json", "board.yjs", "board.json"]) {
      if (!entries.has(required)) throw invalidArchive("В архиве не хватает обязательного файла.");
    }
    return { zip, entries };
  } catch (error) {
    zip.close();
    throw error;
  }
}

export async function readArchiveEntry(zip: yauzl.ZipFile, entry: yauzl.Entry, signal: AbortSignal): Promise<Buffer> {
  const stream = addAbortSignal(signal, await zip.openReadStreamPromise(entry));
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const input of stream) {
    const chunk = Buffer.isBuffer(input) ? input : Buffer.from(input);
    total += chunk.byteLength;
    if (total > entryLimit(entry.fileName)) {
      stream.destroy();
      throw invalidArchive("Файл внутри архива слишком большой.");
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, total);
}

export function verifyStream(expected: ArchiveFile): Transform {
  const hash = createHash("sha256");
  let size = 0;
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      size += chunk.byteLength;
      if (size > expected.bytes) { callback(invalidArchive("Размер файла не совпадает с описанием архива.")); return; }
      hash.update(chunk);
      callback(null, chunk);
    },
    flush(callback) {
      if (size !== expected.bytes || hash.digest("hex") !== expected.sha256) callback(invalidArchive("Файл не прошёл проверку целостности."));
      else callback();
    },
  });
}

export async function extractArchiveEntry(
  zip: yauzl.ZipFile, entry: yauzl.Entry, target: string, expected: ArchiveFile, signal: AbortSignal,
): Promise<void> {
  if (entry.uncompressedSize !== expected.bytes) throw invalidArchive();
  await pipeline(
    await zip.openReadStreamPromise(entry), byteLimit(entryLimit(entry.fileName)), verifyStream(expected),
    createWriteStream(target, { flags: "wx", mode: 0o600 }), { signal },
  );
}

export async function buildArchiveZip(target: string, sources: readonly ZipSource[], signal: AbortSignal): Promise<number> {
  const zip = new ZipFile();
  const output = zip.outputStream as Readable;
  zip.on("error", (error: Error) => output.destroy(error));
  const finished = pipeline(output, byteLimit(MAX_ARCHIVE_BYTES), createWriteStream(target, { flags: "wx", mode: 0o600 }), { signal });
  try {
    for (const file of sources) {
      if (Buffer.isBuffer(file.source)) {
        zip.addBuffer(file.source, file.path, { compress: true, mode: 0o100600 });
      } else {
        const filename = file.source;
        zip.addReadStreamLazy(file.path, { size: file.bytes, compress: false, mode: 0o100600 }, (callback) => {
          const checked = verifyStream(file);
          void pipeline(createReadStream(filename), checked, { signal }).catch((error: Error) => output.destroy(error));
          callback(null, checked);
        });
      }
    }
    zip.end();
    await finished;
    return (await stat(target)).size;
  } catch (error) {
    output.destroy(error instanceof Error ? error : new Error("Archive output failed"));
    await finished.catch(() => undefined);
    throw error;
  }
}
