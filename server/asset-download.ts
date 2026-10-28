import type { ReadStream } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";
import { Readable } from "node:stream";

import { resolveStoragePath } from "./asset-storage";
import { HttpError } from "./http-error";

const STREAM_BUFFER_BYTES = 64 * 1024;

interface DownloadAsset {
  readonly id: string;
  readonly storageKey: string;
  readonly mimeType: string;
  readonly byteSize: number;
}

export interface AssetDownloadOptions {
  readonly head?: boolean;
  readonly signal?: AbortSignal;
}

function unavailable(): HttpError {
  return new HttpError(404, "ASSET_NOT_FOUND", "Изображение недоступно.");
}

/** Takes ownership of the open file; the standard stream closes it on EOF, error or cancellation. */
export async function createAssetDownloadResponse(
  asset: DownloadAsset, { head = false, signal }: AssetDownloadOptions = {},
): Promise<Response> {
  let file: FileHandle | undefined;
  let stream: ReadStream | undefined;
  let closeBeforeStream: (() => void) | undefined;
  try {
    signal?.throwIfAborted();
    if (asset.mimeType !== "image/webp" || !Number.isSafeInteger(asset.byteSize) || asset.byteSize < 12) {
      throw unavailable();
    }
    file = await open(resolveStoragePath(asset.storageKey), "r");
    const openedFile = file;
    closeBeforeStream = () => { void openedFile.close().catch(() => undefined); };
    signal?.addEventListener("abort", closeBeforeStream, { once: true });
    signal?.throwIfAborted();
    const stat = await file.stat();
    signal?.throwIfAborted();
    if (!stat.isFile() || stat.size !== asset.byteSize) throw unavailable();
    // Upload and archive import only persist normalized WebP, never arbitrary HTML/SVG.
    const header = Buffer.alloc(12);
    const { bytesRead } = await file.read(header, 0, header.length, 0);
    signal?.throwIfAborted();
    if (bytesRead !== header.length || header.toString("latin1", 0, 4) !== "RIFF" ||
        header.toString("latin1", 8, 12) !== "WEBP" || header.readUInt32LE(4) + 8 !== stat.size) {
      throw unavailable();
    }
    const headers = {
      "Content-Type": asset.mimeType,
      "Content-Length": String(stat.size),
      "Content-Disposition": `inline; filename="${asset.id}.webp"`,
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    };
    if (head) {
      await file.close();
      signal?.throwIfAborted();
      return new Response(null, { headers });
    }
    stream = file.createReadStream({
      start: 0, end: stat.size - 1, highWaterMark: STREAM_BUFFER_BYTES, autoClose: true, signal,
    });
    const body = Readable.toWeb(stream, {
      // Without size(), toWeb's queue counts chunks, allowing a whole image to be buffered.
      strategy: { highWaterMark: STREAM_BUFFER_BYTES, size: (chunk: Uint8Array) => chunk.byteLength },
    });
    return new Response(body as ReadableStream<Uint8Array>, { headers });
  } catch {
    stream?.destroy();
    await file?.close().catch(() => undefined);
    signal?.throwIfAborted();
    throw unavailable();
  } finally {
    if (closeBeforeStream) signal?.removeEventListener("abort", closeBeforeStream);
  }
}
