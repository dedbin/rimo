import { pageMetrics, PdfJobError } from "../../export-worker/contract";
import type { PdfPreview } from "../../export-worker/contract";
import { PDF_CONTENT_POLICY, renderPdfHtml } from "../../export-worker/render";
import { localPdfResources } from "../../export-worker/resources";
import { parsePdfRequest } from "../../export-worker/validation";
import { requireBoardAccess } from "../access";
import { handleApi, readRequestBuffer } from "../http";
import { HttpError } from "../http-error";
import { capturePdfSnapshot } from "./snapshot";
import { pdfSnapshotStore } from "./store";
import { pdfWarnings } from "./warnings";
import { inspectSnapshot, printSnapshot } from "./worker-client";

export function handlePdfApi(operation: () => Promise<Response>): Promise<Response> {
  return handleApi(async () => {
    try { return await operation(); }
    catch (error) {
      if (error instanceof PdfJobError) throw new HttpError(error.status, error.code, error.message);
      throw error;
    }
  });
}

export async function preparePdfPreview(boardId: string, userId: string, request: Request): Promise<PdfPreview> {
  await requireBoardAccess(boardId, userId);
  return pdfSnapshotStore().prepare(async () => {
    let value: unknown;
    try { value = JSON.parse((await readRequestBuffer(request, 512 * 1024)).toString("utf8")) as unknown; }
    catch (error) {
      if (error instanceof HttpError) throw error;
      throw new HttpError(400, "INVALID_JSON", "Некорректный запрос предпросмотра.");
    }
    const job = await capturePdfSnapshot(boardId, parsePdfRequest(value), request.signal);
    const warnings = [...pdfWarnings(job), ...await inspectSnapshot(job, request.signal)];
    request.signal.throwIfAborted();
    await requireBoardAccess(boardId, userId);
    const stored = pdfSnapshotStore().put(boardId, userId, job, warnings);
    return { token: stored.token, revision: job.revision, savedAt: job.savedAt, expiresAt: new Date(stored.expiresAt).toISOString(),
      pages: job.pages.map((page) => ({ name: page.name, format: page.format, orientation: page.orientation, scale: pageMetrics(page).scale })), warnings };
  });
}

export async function previewPdfPage(boardId: string, userId: string, token: string, page: number): Promise<Response> {
  await requireBoardAccess(boardId, userId);
  const snapshot = pdfSnapshotStore().get(token, boardId, userId);
  if (!Number.isInteger(page) || page < 0 || page >= snapshot.job.pages.length) throw new HttpError(400, "PDF_PAGE_NOT_FOUND", "Страница предпросмотра недоступна.");
  return new Response(renderPdfHtml(snapshot.job, await localPdfResources(), page), { headers: {
    "Content-Type": "text/html; charset=utf-8", "Cache-Control": "private, no-store",
    "Content-Security-Policy": `${PDF_CONTENT_POLICY}; sandbox`, "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer", "X-Frame-Options": "SAMEORIGIN",
  } });
}

export async function downloadPdf(boardId: string, userId: string, token: string, acceptWarnings: boolean, signal: AbortSignal): Promise<Response> {
  await requireBoardAccess(boardId, userId);
  const snapshot = pdfSnapshotStore().get(token, boardId, userId);
  if (snapshot.warnings.length && !acceptWarnings) throw new HttpError(409, "PDF_WARNINGS_UNCONFIRMED", "Проверьте предупреждения предпросмотра перед скачиванием.");
  const bytes = await printSnapshot(snapshot.job, signal);
  await requireBoardAccess(boardId, userId);
  return new Response(new Uint8Array(bytes), { headers: {
    "Content-Type": "application/pdf", "Content-Length": String(bytes.byteLength),
    "Content-Disposition": `attachment; filename="rimo-${boardId}-r${snapshot.job.revision}.pdf"`,
    "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff", "X-Rimo-Revision": String(snapshot.job.revision),
  } });
}

export async function discardPdfPreview(boardId: string, userId: string, token: string): Promise<void> {
  await requireBoardAccess(boardId, userId);
  pdfSnapshotStore().delete(token, boardId, userId);
}
