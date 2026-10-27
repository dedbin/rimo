import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { fail } from "../common.mjs";

export async function pdfTools(python) {
  const { stdout } = await promisify(execFile)(python, ["-c", "import json,platform,pypdf,pdfplumber; print(json.dumps({'python':platform.python_version(),'pypdf':pypdf.__version__,'pdfplumber':pdfplumber.__version__}))"],
    { windowsHide: true, timeout: 10_000, maxBuffer: 32_768 });
  const versions = JSON.parse(stdout);
  if (![versions.python, versions.pypdf, versions.pdfplumber].every((value) => typeof value === "string" && value.length <= 64)) throw fail("PDF extractor version check failed");
  return { python: versions.python, pypdf: versions.pypdf, pdfplumber: versions.pdfplumber };
}

/** Fetch runs in Chromium and therefore uses that browser's real network proxy. */
export async function downloadPdf(page, boardId, snapshot, filename) {
  const downloading = page.waitForEvent("download", { timeout: 40_000 });
  void downloading.catch(() => undefined);
  let objectUrl;
  try {
    const metadata = await page.evaluate(async ({ boardId, token, expectedRevision }) => {
      const now = () => performance.timeOrigin + performance.now();
      const requestStartEpochMs = now();
      const requestStartWallEpochMs = Date.now();
      const response = await fetch(`/api/boards/${boardId}/pdf`, { method: "POST", cache: "no-store",
        headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token, acceptWarnings: true }), signal: AbortSignal.timeout(35_000) });
      const headersEpochMs = now();
      if (response.status !== 200 || response.headers.get("content-type") !== "application/pdf" ||
          response.headers.get("x-rimo-revision") !== String(expectedRevision) || Number(response.headers.get("content-length")) > 32 * 1024 * 1024) {
        await response.body?.cancel();
        return { failed: true, status: response.status };
      }
      const blob = await response.blob();
      if (blob.size < 5 || blob.size > 32 * 1024 * 1024) throw new Error("Public PDF body size is invalid");
      const bodyEndEpochMs = now();
      const bodyEndWallEpochMs = Date.now();
      const objectUrl = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = objectUrl; anchor.download = "pdf-lesson-control.pdf";
      document.body.append(anchor); anchor.click(); anchor.remove();
      return { requestStartEpochMs, headersEpochMs, bodyEndEpochMs, requestStartWallEpochMs, bodyEndWallEpochMs,
        revision: expectedRevision, bytes: blob.size, objectUrl };
    }, { boardId, token: snapshot.token, expectedRevision: snapshot.revision });
    if (metadata.failed) throw fail(`Public PDF response contract failed (HTTP ${metadata.status})`);
    objectUrl = metadata.objectUrl;
    const download = await downloading;
    await download.saveAs(filename);
    const bytes = await readFile(filename);
    if (bytes.toString("ascii", 0, 5) !== "%PDF-" || bytes.length !== metadata.bytes) throw fail("Downloaded PDF file did not match the browser response");
    return { requestStartEpochMs: metadata.requestStartEpochMs, headersEpochMs: metadata.headersEpochMs, bodyEndEpochMs: metadata.bodyEndEpochMs,
      requestStartWallEpochMs: metadata.requestStartWallEpochMs, bodyEndWallEpochMs: metadata.bodyEndWallEpochMs,
      revision: metadata.revision, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"), file: path.resolve(filename),
      requestDurationMs: metadata.bodyEndEpochMs - metadata.requestStartEpochMs };
  } finally {
    if (objectUrl && !page.isClosed()) await page.evaluate((url) => URL.revokeObjectURL(url), objectUrl).catch(() => undefined);
  }
}

export async function verifyPdf(python, filename) {
  const result = await promisify(execFile)(python, ["__tests__/pdf-readability.py", filename, "--pages", "20"], {
    windowsHide: true, timeout: 30_000, maxBuffer: 32_768,
  });
  const data = JSON.parse(result.stdout);
  if (data.pages !== 20 || data.russian_text_searchable !== true || data.russian_text_copyable !== true ||
      data.page_order_verified !== true || data.independent_pdfminer_exact_phrases !== true) throw fail("PDF page/text verification did not pass");
  return { pages: 20, russian_text_searchable: true, russian_text_copyable: true, page_order_verified: true,
    independent_pdfminer_exact_phrases: true, paper_sizes_pt: data.paper_sizes_pt };
}
