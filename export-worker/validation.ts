import { parseFrame } from "../lib/board/frames";
import { parseLayer } from "../lib/board/model";
import { validateRichTextDocument } from "../lib/board/rich-text/validation";
import { LayerType } from "../types/board-canvas";

import { MAX_PDF_ASSET_BYTES, MAX_PDF_IMAGE_PIXELS, MAX_PDF_LAYERS, MAX_PDF_PAGES, MAX_PDF_RENDERED_OBJECTS, MAX_PDF_RENDERED_POINTS, MAX_PDF_RENDER_SOURCE_BYTES, PDF_FORMATS, PdfJobError } from "./contract";
import type { PdfAsset, PdfJob, PdfLayer, PdfPage, PdfPageRequest, PdfRequest } from "./contract";

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) &&
    [Object.prototype, null].includes(Object.getPrototypeOf(value));
}
function validId(value: unknown): value is string { return typeof value === "string" && /^[a-zA-Z0-9_-]{1,128}$/.test(value); }
function invalid(message = "Некорректное задание PDF."): never { throw new PdfJobError(400, "INVALID_PDF", message); }
function pageSettings(value: Record<string, unknown>): Pick<PdfPage, "format" | "orientation"> {
  if (typeof value.format !== "string" || !Object.hasOwn(PDF_FORMATS, value.format) ||
      (value.orientation !== "portrait" && value.orientation !== "landscape")) invalid();
  return { format: value.format as PdfPage["format"], orientation: value.orientation };
}
function ids(value: unknown): string[] {
  if (!Array.isArray(value) || !value.length || value.length > MAX_PDF_LAYERS || !value.every(validId)) invalid();
  return [...new Set(value as string[])];
}

export function parsePdfRequest(value: unknown): PdfRequest {
  if (!record(value) || !Number.isSafeInteger(value.minimumRevision) || (value.minimumRevision as number) < 0 ||
      !Array.isArray(value.pages) || !value.pages.length || value.pages.length > MAX_PDF_PAGES) invalid();
  const pages = value.pages.map((page): PdfPageRequest => {
    if (!record(page) || !record(page.source)) invalid();
    const settings = pageSettings(page);
    if (page.source.type === "selection") return { ...settings, source: { type: "selection", layerIds: ids(page.source.layerIds) } };
    if (page.source.type === "frame" && validId(page.source.frameId)) return { ...settings, source: { type: "frame", frameId: page.source.frameId } };
    return invalid();
  });
  return { minimumRevision: value.minimumRevision as number, pages };
}

function parsePdfLayer(value: unknown): PdfLayer {
  if (!record(value) || !validId(value.id)) invalid();
  const layer = parseLayer(value.layer);
  if (!layer) invalid("PDF содержит неподдерживаемый объект.");
  if (layer.type === LayerType.Text || layer.type === LayerType.Sticker) {
    try { return { id: value.id, layer, richText: validateRichTextDocument(value.richText) }; }
    catch { return invalid("PDF содержит неподдерживаемый текст."); }
  }
  return { id: value.id, layer };
}

export function parsePdfJob(value: unknown): PdfJob {
  if (!record(value) || value.version !== 1 || typeof value.title !== "string" || value.title.length > 200 ||
      !Number.isSafeInteger(value.revision) || (value.revision as number) < 0 ||
      typeof value.savedAt !== "string" || !Number.isFinite(Date.parse(value.savedAt)) ||
      !Array.isArray(value.layers) || !value.layers.length || value.layers.length > MAX_PDF_LAYERS ||
      !Array.isArray(value.assets) || value.assets.length > 100 ||
      !Array.isArray(value.pages) || !value.pages.length || value.pages.length > MAX_PDF_PAGES) invalid();
  const layers = value.layers.map(parsePdfLayer);
  const available = new Set(layers.map((item) => item.id));
  if (available.size !== layers.length) invalid();
  let bytes = 0;
  let pixels = 0;
  const assets = value.assets.map((asset): PdfAsset => {
    if (!record(asset) || !validId(asset.id) || typeof asset.data !== "string" ||
        !/^[A-Za-z0-9+/]+={0,2}$/.test(asset.data) || asset.data.length % 4 !== 0 ||
        !Number.isSafeInteger(asset.width) || !Number.isSafeInteger(asset.height) ||
        (asset.width as number) < 1 || (asset.height as number) < 1) invalid();
    bytes += Buffer.byteLength(asset.data, "base64");
    pixels += (asset.width as number) * (asset.height as number);
    const signature = Buffer.from(asset.data.slice(0, 32), "base64");
    if (bytes > MAX_PDF_ASSET_BYTES || pixels > MAX_PDF_IMAGE_PIXELS ||
        signature.toString("ascii", 0, 4) !== "RIFF" || signature.toString("ascii", 8, 12) !== "WEBP") invalid("Изображения превышают предел PDF или имеют неподдерживаемый формат.");
    return { id: asset.id, data: asset.data, width: asset.width as number, height: asset.height as number };
  });
  const assetIds = new Set(assets.map((asset) => asset.id));
  if (assetIds.size !== assets.length || layers.some(({ layer }) => layer.type === LayerType.Image && !assetIds.has(layer.src.slice("/api/assets/".length)))) invalid("В PDF не хватает изображений.");
  const pages = value.pages.map((page): PdfPage => {
    if (!record(page) || !record(page.bounds)) invalid();
    const bounds = parseFrame({ ...page.bounds, name: page.name });
    if (!bounds) invalid();
    const layerIds = ids(page.layerIds);
    if (layerIds.some((id) => !available.has(id))) invalid();
    return { ...pageSettings(page), name: bounds.name, bounds: { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height }, layerIds };
  });
  const costs = new Map(layers.map((item) => [item.id, { bytes: Buffer.byteLength(JSON.stringify(item)), points: item.layer.type === LayerType.Path ? item.layer.points.length : 0 }]));
  const rendered = pages.flatMap((page) => [...page.layerIds]);
  if (rendered.length > MAX_PDF_RENDERED_OBJECTS || rendered.reduce((sum, id) => sum + costs.get(id)!.bytes, 0) > MAX_PDF_RENDER_SOURCE_BYTES ||
      rendered.reduce((sum, id) => sum + costs.get(id)!.points, 0) > MAX_PDF_RENDERED_POINTS) {
    throw new PdfJobError(413, "PDF_TOO_COMPLEX", "Слишком много сложных объектов на страницах PDF. Уменьшите число страниц или разделите экспорт.");
  }
  return { version: 1, title: value.title, revision: value.revision as number, savedAt: value.savedAt, layers, assets, pages };
}
