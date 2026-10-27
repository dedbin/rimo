import type { RichTextDocument } from "../lib/board/rich-text/types";
import type { Layer, XYWH } from "../types/board-canvas";

export const MAX_PDF_PAGES = 20;
export const MAX_PDF_LAYERS = 3_000;
export const MAX_PDF_ASSET_BYTES = 16 * 1024 * 1024;
export const MAX_PDF_IMAGE_PIXELS = 40_000_000;
export const MAX_PDF_JOB_BYTES = 28 * 1024 * 1024;
export const MAX_PDF_BYTES = 32 * 1024 * 1024;
export const MAX_PDF_HTML_BYTES = 48 * 1024 * 1024;
export const MAX_PDF_RENDER_SOURCE_BYTES = 8 * 1024 * 1024;
export const MAX_PDF_RENDERED_OBJECTS = 20_000;
export const MAX_PDF_RENDERED_POINTS = 500_000;
export const PDF_JOB_TIMEOUT_MS = 30_000;
export const PDF_CONTENT_POLICY = "default-src 'none'; img-src data:; font-src data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; connect-src 'none'; object-src 'none'";
export const PDF_FORMATS = { A4: [210, 297], A3: [297, 420], Letter: [215.9, 279.4] } as const;
export type PdfFormat = keyof typeof PDF_FORMATS;
export type PdfOrientation = "portrait" | "landscape";

export interface PdfPageRequest {
  readonly source: { readonly type: "selection"; readonly layerIds: readonly string[] } | { readonly type: "frame"; readonly frameId: string };
  readonly format: PdfFormat;
  readonly orientation: PdfOrientation;
}

export interface PdfRequest { readonly minimumRevision: number; readonly pages: readonly PdfPageRequest[] }
export interface PdfLayer { readonly id: string; readonly layer: Layer; readonly richText?: RichTextDocument }
export interface PdfAsset { readonly id: string; readonly data: string; readonly width: number; readonly height: number }
export interface PdfPage {
  readonly name: string;
  readonly bounds: XYWH;
  readonly layerIds: readonly string[];
  readonly format: PdfFormat;
  readonly orientation: PdfOrientation;
}
export interface PdfJob {
  readonly version: 1;
  readonly title: string;
  readonly revision: number;
  readonly savedAt: string;
  readonly layers: readonly PdfLayer[];
  readonly assets: readonly PdfAsset[];
  readonly pages: readonly PdfPage[];
}
export interface PdfWarning { readonly page: number; readonly code: "SMALL_TEXT" | "CLIPPED_OBJECT" | "TEXT_OVERFLOW"; readonly message: string }
export interface PdfPreview {
  readonly token: string;
  readonly revision: number;
  readonly savedAt: string;
  readonly expiresAt: string;
  readonly pages: readonly { readonly name: string; readonly format: PdfFormat; readonly orientation: PdfOrientation; readonly scale: number }[];
  readonly warnings: readonly PdfWarning[];
}

export class PdfJobError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
    this.name = "PdfJobError";
  }
}

export function pageMetrics(page: Pick<PdfPage, "format" | "orientation" | "bounds">): {
  width: number; height: number; scale: number; left: number; top: number; contentWidth: number; contentHeight: number;
} {
  const dimensions = PDF_FORMATS[page.format];
  const [widthMm, heightMm] = page.orientation === "portrait" ? dimensions : [dimensions[1], dimensions[0]];
  const width = widthMm * 96 / 25.4;
  const height = heightMm * 96 / 25.4;
  const margin = 12 * 96 / 25.4;
  const contentWidth = width - margin * 2;
  const contentHeight = height - margin * 2 - 28;
  const scale = Math.min(contentWidth / page.bounds.width, contentHeight / page.bounds.height);
  return { width, height, scale, left: margin + (contentWidth - page.bounds.width * scale) / 2,
    top: margin + 28 + (contentHeight - page.bounds.height * scale) / 2, contentWidth, contentHeight };
}
