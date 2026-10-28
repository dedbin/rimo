import { timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";

import { inspectPdf, printPdf } from "./browser";
import { MAX_PDF_HTML_BYTES, MAX_PDF_JOB_BYTES, PdfJobError } from "./contract";
import { PdfQueue } from "./queue";
import { renderPdfHtml } from "./render";
import { localPdfResources } from "./resources";
import { parsePdfJob } from "./validation";

function authorized(request: IncomingMessage, token: string): boolean {
  const value = Buffer.from(request.headers.authorization ?? "");
  const expected = Buffer.from(`Bearer ${token}`);
  return value.length === expected.length && timingSafeEqual(value, expected);
}

async function readBody(request: IncomingMessage, signal: AbortSignal): Promise<unknown> {
  if (Number(request.headers["content-length"] ?? 0) > MAX_PDF_JOB_BYTES) throw new PdfJobError(413, "PDF_TOO_LARGE", "Задание PDF слишком большое.");
  const chunks: Buffer[] = [];
  let total = 0;
  const abort = (): void => { request.destroy(); };
  signal.addEventListener("abort", abort, { once: true });
  try {
    for await (const chunk of request) {
      signal.throwIfAborted();
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
      total += bytes.byteLength;
      if (total > MAX_PDF_JOB_BYTES) throw new PdfJobError(413, "PDF_TOO_LARGE", "Задание PDF слишком большое.");
      chunks.push(bytes);
    }
    try { return JSON.parse(Buffer.concat(chunks, total).toString("utf8")) as unknown; }
    catch { throw new PdfJobError(400, "INVALID_PDF", "Некорректное задание PDF."); }
  } finally { signal.removeEventListener("abort", abort); }
}

function errorResponse(response: ServerResponse, error: unknown): void {
  if (response.destroyed || response.headersSent) return;
  const known = error instanceof PdfJobError;
  response.writeHead(known ? error.status : 500, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  response.end(JSON.stringify({ error: { code: known ? error.code : "PDF_FAILED", message: known ? error.message : "Не удалось сформировать PDF." } }));
}

async function sendPreview(response: ServerResponse, bytes: Buffer, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const dispose = (): void => {
      signal.removeEventListener("abort", abort);
      response.off("finish", finish);
      response.off("close", close);
      response.off("error", fail);
    };
    const finish = (): void => { dispose(); resolve(); };
    const fail = (error: unknown): void => { dispose(); response.destroy(); reject(error); };
    const abort = (): void => fail(signal.reason);
    const close = (): void => {
      if (response.writableFinished) finish();
      else fail(new PdfJobError(499, "PDF_CANCELLED", "Экспорт отменён."));
    };
    signal.addEventListener("abort", abort, { once: true });
    response.once("finish", finish);
    response.once("close", close);
    response.once("error", fail);
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Content-Length": bytes.byteLength });
    response.end(bytes);
  });
}

export function createPdfWorker(token: string): Server {
  if (token.length < 32) throw new Error("PDF_WORKER_TOKEN must contain at least 32 characters");
  const queue = new PdfQueue();
  const server = createServer((request, response) => {
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("X-Content-Type-Options", "nosniff");
    if (request.method === "GET" && request.url === "/healthz") {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ ok: true, ...queue.status }));
      return;
    }
    if (!authorized(request, token)) { response.writeHead(401); response.end(); return; }
    const preview = /^\/preview\?page=(0|[1-9]\d?)$/.exec(request.url ?? "");
    if (request.method !== "POST" || (!preview && !["/inspect", "/render"].includes(request.url ?? ""))) { response.writeHead(404); response.end(); return; }
    if (request.headers["content-type"] !== "application/json") { response.writeHead(415); response.end(); return; }
    const cancelled = new AbortController();
    const cancel = (): void => { if (!response.writableFinished) cancelled.abort(new PdfJobError(499, "PDF_CANCELLED", "Экспорт отменён.")); };
    request.once("aborted", cancel);
    response.once("close", cancel);
    void queue.run(async (signal) => {
      const job = parsePdfJob(await readBody(request, signal));
      signal.throwIfAborted();
      if (preview) {
        const page = Number(preview[1]);
        if (page >= job.pages.length) throw new PdfJobError(400, "PDF_PAGE_NOT_FOUND", "Страница предпросмотра недоступна.");
        const resources = await localPdfResources();
        signal.throwIfAborted();
        const html = renderPdfHtml(job, resources, page);
        const bytes = Buffer.from(html, "utf8");
        if (bytes.byteLength > MAX_PDF_HTML_BYTES) throw new PdfJobError(413, "PDF_TOO_COMPLEX", "Страница PDF слишком сложная. Уменьшите область экспорта.");
        await sendPreview(response, bytes, signal);
      } else if (request.url === "/inspect") {
        const warnings = await inspectPdf(job, signal);
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ warnings }));
      } else {
        const bytes = await printPdf(job, signal);
        response.writeHead(200, { "Content-Type": "application/pdf", "Content-Length": bytes.byteLength });
        response.end(bytes);
      }
    }, cancelled.signal).catch((error: unknown) => errorResponse(response, error)).finally(() => {
      request.off("aborted", cancel);
      response.off("close", cancel);
    });
  });
  server.requestTimeout = 35_000;
  server.headersTimeout = 5_000;
  server.keepAliveTimeout = 5_000;
  server.maxConnections = 8;
  return server;
}
