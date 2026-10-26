import { randomUUID } from "node:crypto";

import { ZipFile } from "yazl";
import * as Y from "yjs";

import { initializeDocument } from "../collaboration-server/document";
import { ARCHIVE_FORMAT, ARCHIVE_VERSION, sha256 } from "../server/archive/format";
import type { ArchiveManifest } from "../server/archive/format";
import { portableBoard } from "../server/archive/portable";

export async function zipBuffers(files: readonly { path: string; data: Buffer }[]): Promise<Buffer> {
  const zip = new ZipFile();
  const chunks: Buffer[] = [];
  const result = new Promise<Buffer>((resolve, reject) => {
    zip.on("error", reject);
    zip.outputStream.on("error", reject);
    zip.outputStream.on("data", (chunk: Buffer) => chunks.push(chunk));
    zip.outputStream.on("end", () => resolve(Buffer.concat(chunks)));
  });
  for (const file of files) zip.addBuffer(file.data, file.path, { compress: true });
  zip.end();
  return result;
}

export async function nativeArchive(options: {
  asset?: Buffer;
  duplicate?: boolean;
  extra?: { path: string; data: Buffer };
  corruptHash?: boolean;
  portable?: Buffer;
  mismatchedView?: boolean;
  configure?: (document: Y.Doc) => void;
} = {}): Promise<Buffer> {
  const document = new Y.Doc();
  initializeDocument(document);
  options.configure?.(document);
  const state = Buffer.from(Y.encodeStateAsUpdate(document));
  const portable = options.portable ?? (options.mismatchedView
    ? Buffer.from(JSON.stringify({ ...JSON.parse(portableBoard(document).toString("utf8")), layerIds: ["invented"] }))
    : portableBoard(document));
  const assetId = randomUUID();
  const manifest: ArchiveManifest = {
    format: ARCHIVE_FORMAT, version: ARCHIVE_VERSION, createdAt: new Date().toISOString(),
    board: { title: "Архив для проверки", schemaVersion: Number(document.getMap("meta").get("schemaVersion")), revision: 1 },
    document: { path: "board.yjs", bytes: state.byteLength, sha256: options.corruptHash ? "0".repeat(64) : sha256(state) },
    portable: { path: "board.json", bytes: portable.byteLength, sha256: sha256(portable) },
    assets: options.asset ? [{ id: assetId, path: `assets/${assetId}.webp`, bytes: options.asset.byteLength,
      sha256: sha256(options.asset), mimeType: "image/webp", width: 1, height: 1 }] : [],
  };
  const files = [
    { path: "manifest.json", data: Buffer.from(JSON.stringify(manifest)) },
    { path: "board.yjs", data: state }, { path: "board.json", data: portable },
    ...(options.asset ? [{ path: `assets/${assetId}.webp`, data: options.asset }] : []),
    ...(options.duplicate ? [{ path: "board.json", data: portable }] : []),
    ...(options.extra ? [options.extra] : []),
  ];
  document.destroy();
  return zipBuffers(files);
}
