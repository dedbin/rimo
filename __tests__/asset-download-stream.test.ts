// @vitest-environment node

import { randomBytes, randomUUID } from "node:crypto";
import type { ReadStream } from "node:fs";
import * as fs from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";
import path from "node:path";
import { setTimeout as pause } from "node:timers/promises";

import sharp from "sharp";
import { NodeNextRequest, NodeNextResponse } from "next/dist/server/base-http/node";
import { autoImplementMethods } from "next/dist/server/route-modules/app-route/helpers/auto-implement-methods";
import { sendResponse } from "next/dist/server/send-response";
import { NextRequest } from "next/server";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { createAssetDownloadResponse } from "../server/asset-download";
import { GET, HEAD } from "../app/api/assets/[assetId]/route";
import { HttpError } from "../server/http-error";

const { assetQuery, checkAccess, checkSession } = vi.hoisted(() => ({
  assetQuery: vi.fn(), checkAccess: vi.fn(), checkSession: vi.fn(),
}));

vi.mock("../server/db", () => ({ getPool: () => ({ query: assetQuery }), inTransaction: vi.fn() }));
vi.mock("../server/access", async (importOriginal) => ({
  ...await importOriginal<typeof import("../server/access")>(), requireBoardAccess: checkAccess,
}));
vi.mock("../server/session", () => ({ requireSession: checkSession }));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, open: vi.fn(actual.open) };
});

const BUFFER_BYTES = 64 * 1024;
const tempRoot = path.resolve("temp");
const storagePath = path.join(tempRoot, `asset-stream-${randomUUID()}`);
let originalOpen: typeof fs.open;
const opened: { file: FileHandle; streams: ReadStream[] }[] = [];
let small: Buffer;
let large: Buffer;

async function fixture(bytes = small): Promise<{ id: string; storageKey: string; mimeType: string; byteSize: number }> {
  const id = randomUUID();
  const storageKey = `${id}.webp`;
  await fs.writeFile(path.join(storagePath, storageKey), bytes);
  return { id, storageKey, mimeType: "image/webp", byteSize: bytes.length };
}

async function expectClosed(file: FileHandle): Promise<void> {
  await vi.waitFor(() => expect(file.fd).toBe(-1));
  await expect(file.stat()).rejects.toMatchObject({ code: "EBADF" });
}

describe("bounded authenticated asset response body", () => {
  beforeAll(async () => {
    originalOpen = (await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises")).open;
    await fs.mkdir(storagePath, { recursive: true });
    small = await sharp({ create: { width: 3, height: 2, channels: 4, background: "red" } }).webp().toBuffer();
    large = await sharp(randomBytes(1024 * 1024 * 3), {
      raw: { width: 1024, height: 1024, channels: 3 },
    }).webp({ lossless: true }).toBuffer();
    expect(large.length).toBeGreaterThan(2 * 1024 * 1024);
  });

  beforeEach(() => {
    vi.stubEnv("DATABASE_URL", "postgres://unused:unused@localhost/unused");
    vi.stubEnv("BETTER_AUTH_SECRET", "a".repeat(32));
    vi.stubEnv("ASSET_STORAGE_PATH", storagePath);
    assetQuery.mockReset();
    checkAccess.mockReset();
    checkSession.mockReset().mockResolvedValue({ user: { id: randomUUID() } });
    vi.mocked(fs.open).mockImplementation(async (...args: Parameters<typeof fs.open>) => {
      const file = await originalOpen(...args);
      const observation = { file, streams: [] as ReadStream[] };
      opened.push(observation);
      const createReadStream = file.createReadStream.bind(file);
      vi.spyOn(file, "createReadStream").mockImplementation((options) => {
        const stream = createReadStream(options);
        observation.streams.push(stream);
        return stream;
      });
      return file;
    });
  });

  afterEach(async () => {
    for (const { file, streams } of opened.splice(0)) {
      for (const stream of streams) stream.destroy();
      await file.close().catch(() => undefined);
    }
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  afterAll(async () => {
    const resolved = path.resolve(storagePath);
    if (!resolved.startsWith(`${tempRoot}${path.sep}`)) throw new Error("Unsafe test cleanup path");
    await fs.rm(resolved, { recursive: true, force: true });
  });

  it("delivers exact bytes and security headers, closing the real descriptor at EOF", async () => {
    const asset = await fixture();
    const response = await createAssetDownloadResponse(asset);
    expect(response.status).toBe(200);
    expect(Object.fromEntries(response.headers)).toEqual({
      "cache-control": "private, no-store",
      "content-disposition": `inline; filename="${asset.id}.webp"`,
      "content-length": String(small.length),
      "content-type": "image/webp",
      "x-content-type-options": "nosniff",
    });
    expect(Buffer.from(await response.arrayBuffer())).toEqual(small);
    expect(opened[0].streams).toHaveLength(1);
    await expectClosed(opened[0].file);
  });

  it("keeps read-ahead bounded when a multi-megabyte image has a slow consumer", async () => {
    const response = await createAssetDownloadResponse(await fixture(large));
    const stream = opened[0].streams[0];
    const reader = response.body!.getReader();
    await vi.waitFor(() => expect(stream.bytesRead).toBeGreaterThan(0));
    await pause(30);
    expect(stream.bytesRead).toBeLessThanOrEqual(3 * BUFFER_BYTES);
    let consumed = 0;
    for (let index = 0; index < 5; index += 1) {
      const chunk = await reader.read();
      expect(chunk.done).toBe(false);
      consumed += chunk.value!.byteLength;
      await pause(10);
      expect(stream.bytesRead - consumed).toBeLessThanOrEqual(3 * BUFFER_BYTES);
      expect(stream.readableLength).toBeLessThanOrEqual(BUFFER_BYTES);
    }
    expect(stream.bytesRead).toBeLessThan(large.length);
    await reader.cancel();
    await expectClosed(opened[0].file);
  });

  it("cancels an unread response and closes the descriptor without reading the entire file", async () => {
    const response = await createAssetDownloadResponse(await fixture(large));
    const stream = opened[0].streams[0];
    await response.body!.cancel();
    await expectClosed(opened[0].file);
    expect(stream.destroyed).toBe(true);
    expect(stream.bytesRead).toBeLessThan(large.length);
  });

  it("returns a checked HEAD response with no body and an already closed descriptor", async () => {
    const response = await createAssetDownloadResponse(await fixture(large), { head: true });
    expect(response.body).toBeNull();
    expect(response.headers.get("content-length")).toBe(String(large.length));
    expect(response.headers.get("content-type")).toBe("image/webp");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(opened[0].streams).toHaveLength(0);
    expect(opened[0].file.fd).toBe(-1);
  });

  it("does not open a file for an already aborted request", async () => {
    const asset = await fixture();
    const controller = new AbortController();
    controller.abort();
    await expect(createAssetDownloadResponse(asset, { signal: controller.signal }))
      .rejects.toMatchObject({ name: "AbortError" });
    expect(opened).toHaveLength(0);
  });

  it.each(["open", "stat", "read"])("closes a real file when the request aborts during await %s", async (stage) => {
    const asset = await fixture();
    const controller = new AbortController();
    let enter!: () => void;
    let release!: () => void;
    const entered = new Promise<void>((resolve) => { enter = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const observedOpen = vi.mocked(fs.open).getMockImplementation()!;
    vi.mocked(fs.open).mockImplementationOnce(async (...args: Parameters<typeof fs.open>) => {
      const file = await observedOpen(...args);
      const pendingMetadata = () => { enter(); return gate.then(() => { throw new Error("interrupted metadata"); }); };
      if (stage === "open") { enter(); await gate; }
      if (stage === "stat") vi.spyOn(file, "stat").mockImplementationOnce(pendingMetadata);
      if (stage === "read") vi.spyOn(file, "read").mockImplementationOnce(pendingMetadata);
      return file;
    });
    const pending = createAssetDownloadResponse(asset, { signal: controller.signal });
    const rejected = expect(pending).rejects.toMatchObject({ name: "AbortError" });
    await entered;
    controller.abort();
    try {
      // During open, ownership only transfers when the open promise resolves.
      if (stage !== "open") await expectClosed(opened[0].file);
    } finally { release(); }
    await rejected;
    await expectClosed(opened[0].file);
    expect(opened[0].streams).toHaveLength(0);
  });

  it("aborts an unconsumed response after handoff and closes its descriptor", async () => {
    const controller = new AbortController();
    const response = await createAssetDownloadResponse(await fixture(large), { signal: controller.signal });
    const stream = opened[0].streams[0];
    await vi.waitFor(() => expect(stream.bytesRead).toBeGreaterThan(0));
    controller.abort();
    await expectClosed(opened[0].file);
    const outcome = await response.arrayBuffer().then(
      (bytes) => ({ length: bytes.byteLength }),
      (error: Error) => ({ name: error.name }),
    );
    expect(outcome).toEqual({ name: "AbortError" });
    expect(stream.bytesRead).toBeLessThan(large.length);
  });

  it("uses the explicit asset HEAD through Next's method dispatch and response sender", async () => {
    const asset = await fixture(large);
    assetQuery.mockResolvedValue({ rows: [{ id: asset.id, storage_key: asset.storageKey,
      board_id: randomUUID(), mime_type: asset.mimeType, byte_size: String(asset.byteSize) }] });
    const context = { params: Promise.resolve({ assetId: asset.id }) };
    const methods = autoImplementMethods({ GET: (request) => GET(request, context), HEAD: (request) => HEAD(request, context) });
    const request = new NextRequest(`http://localhost/api/assets/${asset.id}`, { method: "HEAD" });
    const response = await methods.HEAD(request, context);
    if (!(response instanceof Response)) throw new Error("Invalid Next HEAD response");
    expect(response.status).toBe(200);
    expect(response.body).toBeNull();
    expect(opened[0].file.fd).toBe(-1);
    expect(opened[0].streams).toHaveLength(0);
    expect(checkAccess).toHaveBeenCalledOnce();
    const incoming = new IncomingMessage(new Socket());
    incoming.method = "HEAD";
    incoming.url = request.url;
    const outgoing = new ServerResponse(incoming);
    await sendResponse(new NodeNextRequest(incoming), new NodeNextResponse(outgoing), response);
    expect(outgoing.writableEnded).toBe(true);
    expect(String(outgoing.getHeader("content-length"))).toBe(String(large.length));
    outgoing.destroy();
    incoming.destroy();
    await expectClosed(opened[0].file);
  });

  it("propagates GET request.signal even when Next skips an already destroyed response", async () => {
    const asset = await fixture(large);
    assetQuery.mockResolvedValue({ rows: [{ id: asset.id, storage_key: asset.storageKey,
      board_id: randomUUID(), mime_type: asset.mimeType, byte_size: String(asset.byteSize) }] });
    const controller = new AbortController();
    const request = new Request(`http://localhost/api/assets/${asset.id}`, { signal: controller.signal });
    const response = await GET(request, { params: Promise.resolve({ assetId: asset.id }) });
    expect(response.status).toBe(200);
    const incoming = new IncomingMessage(new Socket());
    incoming.method = "GET";
    incoming.url = request.url;
    const outgoing = new ServerResponse(incoming);
    outgoing.destroy();
    await sendResponse(new NodeNextRequest(incoming), new NodeNextResponse(outgoing), response);
    expect(response.bodyUsed).toBe(false);
    controller.abort();
    await expectClosed(opened[0].file);
    expect(opened[0].streams[0].destroyed).toBe(true);
    incoming.destroy();
  });

  it("requires session and board visibility for HEAD before opening any file", async () => {
    const asset = await fixture();
    const context = { params: Promise.resolve({ assetId: asset.id }) };
    const request = new Request(`http://localhost/api/assets/${asset.id}`, { method: "HEAD" });
    checkSession.mockRejectedValueOnce(new HttpError(401, "UNAUTHORIZED", "Войдите в аккаунт."));
    expect((await HEAD(request, context)).status).toBe(401);
    expect(assetQuery).not.toHaveBeenCalled();
    assetQuery.mockResolvedValue({ rows: [{ id: asset.id, storage_key: asset.storageKey,
      board_id: randomUUID(), mime_type: asset.mimeType, byte_size: String(asset.byteSize) }] });
    checkAccess.mockRejectedValueOnce(new HttpError(404, "BOARD_NOT_FOUND", "Доска недоступна."));
    expect((await HEAD(request, context)).status).toBe(404);
    expect(opened).toHaveLength(0);
  });

  it("propagates an I/O stream error and closes its real file descriptor", async () => {
    const response = await createAssetDownloadResponse(await fixture(large));
    const reader = response.body!.getReader();
    const failed = expect(reader.closed).rejects.toThrow("read failed");
    opened[0].streams[0].destroy(new Error("read failed"));
    await failed;
    await expect(reader.read()).rejects.toThrow("read failed");
    await expectClosed(opened[0].file);
  });

  it("also closes a stream when Response construction fails before ownership transfers", async () => {
    const asset = await fixture(large);
    vi.stubGlobal("Response", class { constructor() { throw new Error("invalid response"); } });
    await expect(createAssetDownloadResponse(asset)).rejects.toMatchObject({ status: 404, code: "ASSET_NOT_FOUND" });
    await expectClosed(opened[0].file);
    expect(opened[0].streams[0].destroyed).toBe(true);
  });

  it("returns a safe error for a missing file without disclosing a filesystem path", async () => {
    const id = randomUUID();
    await expect(createAssetDownloadResponse({ id, storageKey: `${id}.webp`, mimeType: "image/webp", byteSize: 100 }))
      .rejects.toMatchObject({ status: 404, code: "ASSET_NOT_FOUND", message: "Изображение недоступно." });
    expect(opened).toHaveLength(0);
  });

  it.each(["truncated", "oversized", "invalid header", "non-ASCII header", "invalid RIFF size"])("rejects a %s file before a response and closes it", async (corruption) => {
    const bytes = Buffer.from(small);
    const asset = await fixture(bytes);
    if (corruption === "truncated") await fs.truncate(path.join(storagePath, asset.storageKey), small.length - 1);
    if (corruption === "oversized") await fs.appendFile(path.join(storagePath, asset.storageKey), Buffer.from([0]));
    if (corruption === "invalid header") { bytes.write("<svg", 0); await fs.writeFile(path.join(storagePath, asset.storageKey), bytes); }
    if (corruption === "non-ASCII header") { bytes[0] |= 128; await fs.writeFile(path.join(storagePath, asset.storageKey), bytes); }
    if (corruption === "invalid RIFF size") { bytes.writeUInt32LE(1, 4); await fs.writeFile(path.join(storagePath, asset.storageKey), bytes); }
    await expect(createAssetDownloadResponse(asset)).rejects.toMatchObject({ status: 404, code: "ASSET_NOT_FOUND" });
    expect(opened[0].streams).toHaveLength(0);
    await expectClosed(opened[0].file);
  });

  it("rejects unsupported MIME and invalid lengths before opening a file", async () => {
    const asset = await fixture();
    for (const invalid of [{ mimeType: "text/html" }, { byteSize: NaN }, { byteSize: -1 }, { byteSize: 0 }]) {
      await expect(createAssetDownloadResponse({ ...asset, ...invalid })).rejects.toMatchObject({ status: 404 });
    }
    expect(opened).toHaveLength(0);
  });

  it("rejects a directory masquerading as an image", async () => {
    const id = randomUUID();
    await fs.mkdir(path.join(storagePath, `${id}.webp`));
    await expect(createAssetDownloadResponse({ id, storageKey: `${id}.webp`, mimeType: "image/webp", byteSize: 100 }))
      .rejects.toMatchObject({ status: 404 });
    for (const { file } of opened) await expectClosed(file);
  });
});
