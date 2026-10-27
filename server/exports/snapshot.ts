import { createHash } from "node:crypto";

import * as Y from "yjs";

import { validateDocument } from "../../collaboration-server/document";
import { DEFAULT_LIMITS } from "../../collaboration-server/types";
import { MAX_PDF_ASSET_BYTES, MAX_PDF_IMAGE_PIXELS, MAX_PDF_LAYERS } from "../../export-worker/contract";
import type { PdfAsset, PdfJob, PdfLayer, PdfPage, PdfRequest } from "../../export-worker/contract";
import { parsePdfJob } from "../../export-worker/validation";
import { boundsForLayers, FRAME_ROOT, intersectsBounds, parseFrame, visualBounds } from "../../lib/board/frames";
import { normalizeLayerOrder, parseLayer } from "../../lib/board/model";
import { getRichTextJson } from "../../lib/board/rich-text/document";
import { LayerType } from "../../types/board-canvas";
import type { Layer } from "../../types/board-canvas";
import { readStoredAsset } from "../asset-storage";
import { isUuid } from "../access";
import { getPool } from "../db";
import { HttpError } from "../http-error";

interface AssetRow { id: string; storage_key: string; byte_size: string; width: number; height: number; mime_type: string; sha256: string }

function selectedPages(document: Y.Doc, request: PdfRequest, layers: ReadonlyMap<string, Layer>, order: readonly string[]): PdfPage[] {
  return request.pages.map((page, index) => {
    if (page.source.type === "selection") {
      const selected = new Set(page.source.layerIds);
      if ([...selected].some((id) => !layers.has(id))) throw new HttpError(409, "PDF_SELECTION_CHANGED", "Выделение изменилось. Дождитесь сохранения и создайте предпросмотр заново.");
      const layerIds = order.filter((id) => selected.has(id));
      const bounds = boundsForLayers(layerIds.map((id) => layers.get(id)!));
      if (!bounds) throw new HttpError(400, "PDF_EMPTY_PAGE", "Выберите объекты для PDF.");
      return { format: page.format, orientation: page.orientation, name: request.pages.length === 1 ? "Выделение" : `Выделение ${index + 1}`, bounds, layerIds };
    }
    const raw = document.getMap(FRAME_ROOT).get(page.source.frameId);
    const frame = raw instanceof Y.Map ? parseFrame(raw.toJSON()) : null;
    if (!frame) throw new HttpError(409, "PDF_FRAME_CHANGED", "Фрейм изменился. Дождитесь сохранения и создайте предпросмотр заново.");
    const layerIds = order.filter((id) => intersectsBounds(visualBounds(layers.get(id)!), frame));
    if (!layerIds.length) throw new HttpError(400, "PDF_EMPTY_PAGE", `Фрейм «${frame.name}» пуст.`);
    return { format: page.format, orientation: page.orientation, name: frame.name,
      bounds: { x: frame.x, y: frame.y, width: frame.width, height: frame.height }, layerIds };
  });
}

async function captureAssets(boardId: string, layers: readonly PdfLayer[], signal: AbortSignal): Promise<PdfAsset[]> {
  const assetIds = [...new Set(layers.flatMap(({ layer }) => layer.type === LayerType.Image ? [layer.src.slice("/api/assets/".length)] : []))];
  if (!assetIds.length) return [];
  if (assetIds.some((id) => !isUuid(id))) throw new HttpError(409, "PDF_ASSET_MISSING", "Некорректная ссылка на изображение доски.");
  if (assetIds.length > 100) throw new HttpError(413, "PDF_TOO_MANY_IMAGES", "Для одного PDF разрешено до 100 изображений.");
  const result = await getPool().query<AssetRow>(
    "SELECT id, storage_key, byte_size, width, height, mime_type, sha256 FROM assets WHERE board_id = $1 AND id = ANY($2::uuid[]) ORDER BY id", [boardId, assetIds],
  );
  if (result.rows.length !== assetIds.length) throw new HttpError(409, "PDF_ASSET_MISSING", "Не найдены все изображения этой доски.");
  const total = result.rows.reduce((sum, asset) => sum + Number(asset.byte_size), 0);
  const pixels = result.rows.reduce((sum, asset) => sum + asset.width * asset.height, 0);
  if (total > MAX_PDF_ASSET_BYTES || pixels > MAX_PDF_IMAGE_PIXELS || result.rows.some((asset) => asset.mime_type !== "image/webp" || Number(asset.byte_size) < 1)) {
    throw new HttpError(413, "PDF_IMAGES_TOO_LARGE", "Изображения PDF должны занимать до 16 МиБ и 40 млн пикселей. Уменьшите область экспорта.");
  }
  const assets: PdfAsset[] = [];
  for (const asset of result.rows) {
    signal.throwIfAborted();
    const bytes = await readStoredAsset(asset.storage_key);
    if (bytes.byteLength !== Number(asset.byte_size) || createHash("sha256").update(bytes).digest("hex") !== asset.sha256) {
      throw new HttpError(409, "PDF_ASSET_CHANGED", "Изображение недоступно или повреждено. Повторите экспорт после проверки файла.");
    }
    assets.push({ id: asset.id, data: bytes.toString("base64"), width: asset.width, height: asset.height });
  }
  return assets;
}

export async function capturePdfSnapshot(boardId: string, request: PdfRequest, signal: AbortSignal): Promise<PdfJob> {
  signal.throwIfAborted();
  const stored = await getPool().query<{ title: string; state: Buffer; revision: string; saved_at: Date }>(
    `SELECT b.title, d.state, d.revision, d.saved_at FROM boards b
     JOIN board_documents d ON d.board_id = b.id WHERE b.id = $1`, [boardId],
  );
  const row = stored.rows[0];
  const revision = Number(row?.revision);
  if (!row || !Number.isSafeInteger(revision) || revision < request.minimumRevision) {
    throw new HttpError(409, "BOARD_NOT_SAVED", "Дождитесь сохранения доски и повторите экспорт.");
  }
  if (row.state.byteLength > DEFAULT_LIMITS.maxDocumentBytes) throw new HttpError(413, "PDF_DOCUMENT_TOO_LARGE", "Доска превышает допустимый размер.");
  const document = new Y.Doc();
  try {
    try { Y.applyUpdate(document, row.state); validateDocument(document, DEFAULT_LIMITS); }
    catch { throw new HttpError(409, "PDF_UNSUPPORTED_DOCUMENT", "PDF требует сохранённую доску текущей версии. Откройте доску и дождитесь сохранения."); }
    const layers = new Map<string, Layer>();
    for (const [id, value] of document.getMap("layers")) {
      const layer = value instanceof Y.Map ? parseLayer(value.toJSON()) : null;
      if (layer) layers.set(id, layer);
    }
    const order = normalizeLayerOrder(document.getArray<string>("layerIds").toArray(), layers);
    const pages = selectedPages(document, request, layers, order);
    const selected = new Set(pages.flatMap((page) => [...page.layerIds]));
    if (selected.size > MAX_PDF_LAYERS) throw new HttpError(413, "PDF_TOO_MANY_LAYERS", "Для одного PDF разрешено до 3000 объектов. Уменьшите область экспорта.");
    const content = order.filter((id) => selected.has(id)).map((id): PdfLayer => {
      const layer = layers.get(id)!;
      return { id, layer, ...(layer.type === LayerType.Text || layer.type === LayerType.Sticker ? { richText: getRichTextJson(document, id) } : {}) };
    });
    const assets = await captureAssets(boardId, content, signal);
    return parsePdfJob({ version: 1, title: row.title, revision, savedAt: new Date(row.saved_at).toISOString(), layers: content, assets, pages });
  } finally { document.destroy(); }
}
