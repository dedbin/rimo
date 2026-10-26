import * as Y from "yjs";

import { normalizeLayerOrder, parseLayer } from "../../lib/board/model";
import { getRichTextJson } from "../../lib/board/rich-text/document";
import { FRAME_ORDER_ROOT, FRAME_ROOT, normalizeFrameOrder, parseFrame } from "../../lib/board/frames";
import type { BoardFrame } from "../../lib/board/frames";
import { LayerType } from "../../types/board-canvas";
import type { Layer } from "../../types/board-canvas";

import { invalidArchive, MAX_PORTABLE_BYTES } from "./format";

export function portableBoard(document: Y.Doc): Buffer {
  const layers = new Map<string, Layer>();
  for (const [id, value] of document.getMap("layers")) {
    const layer = value instanceof Y.Map ? parseLayer(value.toJSON()) : null;
    if (!layer) throw invalidArchive("В документе есть неподдерживаемый объект.");
    layers.set(id, layer);
  }
  const schemaVersion = document.getMap("meta").get("schemaVersion");
  if (schemaVersion !== 1 && schemaVersion !== 2) throw invalidArchive("Версия доски не поддерживается архивом.");
  const richText = schemaVersion === 2 ? Object.fromEntries([...layers].flatMap(([id, layer]) =>
    layer.type === LayerType.Text || layer.type === LayerType.Sticker ? [[id, getRichTextJson(document, id)]] : [],
  )) : undefined;
  const frames = new Map<string, BoardFrame>();
  if (schemaVersion === 2) {
    for (const [id, value] of document.getMap(FRAME_ROOT)) {
      const frame = value instanceof Y.Map ? parseFrame(value.toJSON()) : null;
      if (!frame) throw invalidArchive("В документе есть некорректная область страницы.");
      frames.set(id, frame);
    }
  }
  const result = Buffer.from(JSON.stringify({
    format: "rimo-portable-board", version: schemaVersion === 1 ? 1 : 2, schemaVersion,
    layerIds: normalizeLayerOrder(document.getArray<string>("layerIds").toArray(), layers),
    layers: Object.fromEntries(layers), ...(richText === undefined ? {} : { richText }),
    ...(frames.size ? { frames: Object.fromEntries(frames),
      frameIds: normalizeFrameOrder(document.getArray<string>(FRAME_ORDER_ROOT).toArray(), frames) } : {}),
  }), "utf8");
  if (result.byteLength > MAX_PORTABLE_BYTES) throw invalidArchive("JSON-представление доски слишком большое.");
  return result;
}

export function referencedAssets(document: Y.Doc): ReadonlySet<string> {
  const ids = new Set<string>();
  for (const value of document.getMap("layers").values()) {
    if (!(value instanceof Y.Map) || value.get("type") !== LayerType.Image) continue;
    const src: unknown = value.get("src");
    const match = typeof src === "string" ? /^\/api\/assets\/([a-f0-9-]{36})$/.exec(src) : null;
    if (!match) throw invalidArchive("В документе есть некорректная ссылка на изображение.");
    ids.add(match[1]);
  }
  return ids;
}

export function remapAssets(document: Y.Doc, assets: ReadonlyMap<string, string>): void {
  document.transact(() => {
    for (const value of document.getMap("layers").values()) {
      if (!(value instanceof Y.Map) || value.get("type") !== LayerType.Image) continue;
      const oldId = String(value.get("src")).slice("/api/assets/".length);
      const newId = assets.get(oldId);
      if (!newId) throw invalidArchive("В архиве не хватает изображения доски.");
      value.set("src", `/api/assets/${newId}`);
    }
  });
}
