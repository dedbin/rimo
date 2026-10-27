import { MAX_PDF_BYTES, MAX_PDF_JOB_BYTES, PdfJobError } from "../../export-worker/contract";
import type { PdfJob, PdfWarning } from "../../export-worker/contract";
import { HttpError } from "../http-error";
import { pdfSnapshotStore } from "./store";

async function boundedBody(response: Response, maximum: number): Promise<Buffer> {
  const reader = response.body?.getReader();
  if (!reader) throw new HttpError(502, "PDF_WORKER_INVALID", "Worker вернул пустой ответ.");
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      total += chunk.value.byteLength;
      if (total > maximum) {
        await reader.cancel();
        throw new HttpError(413, "PDF_TOO_LARGE", "Ответ PDF превышает допустимый размер.");
      }
      chunks.push(Buffer.from(chunk.value));
    }
    return Buffer.concat(chunks, total);
  } finally { reader.releaseLock(); }
}

async function dispatchWorkerRequest(endpoint: "inspect" | "render", job: PdfJob, signal: AbortSignal): Promise<Buffer> {
  signal.throwIfAborted();
  const token = process.env.PDF_WORKER_TOKEN;
  if (!token || token.length < 32) throw new HttpError(503, "PDF_NOT_CONFIGURED", "PDF пока не настроен на сервере.");
  const url = new URL(process.env.PDF_WORKER_URL ?? "http://127.0.0.1:3100");
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== "/") {
    throw new Error("PDF_WORKER_URL must be an HTTP(S) origin");
  }
  url.pathname = `/${endpoint}`;
  const body = JSON.stringify(job);
  if (Buffer.byteLength(body) > MAX_PDF_JOB_BYTES) throw new PdfJobError(413, "PDF_SNAPSHOT_TOO_LARGE", "Снимок PDF слишком большой. Уменьшите область экспорта.");
  try {
    const response = await fetch(url, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body,
      signal: AbortSignal.any([signal, AbortSignal.timeout(35_000)]), cache: "no-store", redirect: "error" });
    const bytes = await boundedBody(response, response.ok && endpoint === "render" ? MAX_PDF_BYTES : 32_768);
    if (!response.ok) {
      let message = "Не удалось сформировать PDF.";
      let code = "PDF_FAILED";
      try {
        const value = JSON.parse(bytes.toString("utf8")) as { error?: { code?: unknown; message?: unknown } };
        if (typeof value.error?.message === "string" && value.error.message.length <= 500) message = value.error.message;
        if (typeof value.error?.code === "string" && /^[A-Z_]{1,64}$/.test(value.error.code)) code = value.error.code;
      } catch { /* A worker failure without JSON remains a bounded generic error. */ }
      throw new HttpError([400, 413, 429, 499, 504].includes(response.status) ? response.status : 502, code, message);
    }
    if (endpoint === "render" && (response.headers.get("content-type") !== "application/pdf" || bytes.toString("ascii", 0, 5) !== "%PDF-")) {
      throw new HttpError(502, "PDF_WORKER_INVALID", "Worker вернул некорректный PDF.");
    }
    return bytes;
  } catch (error) {
    if (error instanceof HttpError || error instanceof PdfJobError) throw error;
    if (signal.aborted) throw new HttpError(499, "PDF_CANCELLED", "Экспорт отменён.");
    throw new HttpError(503, "PDF_WORKER_UNAVAILABLE", "PDF-worker недоступен или не ответил вовремя. Повторите немного позже.");
  }
}

async function workerRequest(endpoint: "inspect" | "render", job: PdfJob, signal: AbortSignal): Promise<Buffer> {
  return pdfSnapshotStore().dispatch(() => dispatchWorkerRequest(endpoint, job, signal));
}

export async function inspectSnapshot(job: PdfJob, signal: AbortSignal): Promise<readonly PdfWarning[]> {
  const bytes = await workerRequest("inspect", job, signal);
  let value: { warnings?: unknown };
  try { value = JSON.parse(bytes.toString("utf8")) as { warnings?: unknown }; }
  catch { throw new HttpError(502, "PDF_WORKER_INVALID", "Некорректный ответ предпросмотра."); }
  if (!Array.isArray(value.warnings) || value.warnings.length > job.pages.length) throw new HttpError(502, "PDF_WORKER_INVALID", "Некорректный ответ предпросмотра.");
  return value.warnings.map((warning: unknown): PdfWarning => {
    if (!warning || typeof warning !== "object" || !("page" in warning) || !("code" in warning) || !("message" in warning) ||
        !Number.isInteger(warning.page) || (warning.page as number) < 0 || (warning.page as number) >= job.pages.length ||
        warning.code !== "TEXT_OVERFLOW" || typeof warning.message !== "string" || warning.message.length > 500) {
      throw new HttpError(502, "PDF_WORKER_INVALID", "Некорректный ответ предпросмотра.");
    }
    return { page: warning.page as number, code: "TEXT_OVERFLOW", message: warning.message };
  });
}

export async function printSnapshot(job: PdfJob, signal: AbortSignal): Promise<Buffer> { return workerRequest("render", job, signal); }
