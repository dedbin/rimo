// @vitest-environment node
import { randomBytes } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MAX_PDF_HTML_BYTES } from "../export-worker/contract";
import { previewSnapshot } from "../server/exports/worker-client";
import { pdfFixture } from "./pdf-fixtures";

beforeEach(() => {
  vi.stubEnv("PDF_WORKER_TOKEN", randomBytes(32).toString("base64url"));
  vi.stubEnv("PDF_WORKER_URL", "http://127.0.0.1:3100");
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

describe("bounded preview worker client", () => {
  it("uses the existing dispatch admission before serialization and releases all failed requests", async () => {
    const controllers = Array.from({ length: 3 }, () => new AbortController());
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, options) => new Promise<Response>((_resolve, reject) => {
      options!.signal!.addEventListener("abort", () => reject(options!.signal!.reason), { once: true });
    }));
    const pending = controllers.map((controller) => previewSnapshot(pdfFixture(), 0, controller.signal).catch((error: unknown) => error));
    expect(fetch).toHaveBeenCalledTimes(3);
    const serialize = vi.fn(() => { throw new Error("must not serialize an excess payload"); });
    const source = { ...pdfFixture(), toJSON: serialize };
    await expect(previewSnapshot(source, 0, new AbortController().signal)).rejects.toMatchObject({ status: 429, code: "PDF_BUSY" });
    expect(serialize).not.toHaveBeenCalled();
    controllers.forEach((controller) => controller.abort());
    for (const outcome of await Promise.all(pending)) expect(outcome).toMatchObject({ status: 499, code: "PDF_CANCELLED" });
    fetch.mockResolvedValue(new Response("<!doctype html><html></html>", { headers: { "Content-Type": "text/html; charset=utf-8" } }));
    await expect(previewSnapshot(pdfFixture(), 1, new AbortController().signal)).resolves.toEqual(Buffer.from("<!doctype html><html></html>"));
    expect(String(fetch.mock.calls.at(-1)![0])).toBe("http://127.0.0.1:3100/preview?page=1");
  });

  it("rejects non-HTML and oversized declared worker responses without reading their body", async () => {
    const cases: Record<string, string>[] = [{ "Content-Type": "application/json" }, { "Content-Type": "text/html; charset=utf-8", "Content-Length": String(MAX_PDF_HTML_BYTES + 1) }];
    for (const headers of cases) {
      const cancel = vi.fn();
      const response = new Response(new ReadableStream<Uint8Array>({ cancel }), { headers });
      vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(response);
      await expect(previewSnapshot(pdfFixture(), 0, new AbortController().signal)).rejects.toMatchObject({ status: headers["Content-Length"] ? 413 : 502 });
      expect(cancel).toHaveBeenCalledOnce();
    }
  });

  it("also caps chunked HTML responses and cancels the stream on overflow", async () => {
    const cancel = vi.fn();
    const chunk = new Uint8Array(1024 * 1024);
    const response = new Response(new ReadableStream<Uint8Array>({ pull: (controller) => controller.enqueue(chunk), cancel }), {
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(response);
    await expect(previewSnapshot(pdfFixture(), 0, new AbortController().signal)).rejects.toMatchObject({ status: 413, code: "PDF_TOO_LARGE" });
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("rejects an already cancelled preview before contacting the worker", async () => {
    const fetch = vi.spyOn(globalThis, "fetch");
    const cancelled = AbortSignal.abort();
    await expect(previewSnapshot(pdfFixture(), 0, cancelled)).rejects.toMatchObject({ status: 499 });
    expect(fetch).not.toHaveBeenCalled();
  });
});
