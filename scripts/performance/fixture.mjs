import sharp from "sharp";

import { LayerType } from "../../types/board-canvas.ts";
import { writeRichTextFragment } from "../../lib/board/rich-text/document.ts";
import { fail, Y } from "./common.mjs";

export const VISIBLE_OBJECTS = 500;
export const SCENE_VERSION = 1;
export const VIEWPORT = Object.freeze({ width: 1440, height: 1000 });
export const SELECT_BOX = Object.freeze({ from: { x: 200, y: 200 }, to: { x: 1230, y: 870 } });
export const DRAG_DELTA = Object.freeze({ x: 120, y: 40 });
export const idAt = (index) => `benchmark_${String(index).padStart(5, "0")}`;

export function dragOffset(step, steps) {
  // Cross the production 3px gesture threshold on the first 4px input.
  const distance = Math.hypot(DRAG_DELTA.x, DRAG_DELTA.y);
  const fraction = step === steps ? 1 : (4 + (distance - 4) * (step - 1) / (steps - 1)) / distance;
  return { x: DRAG_DELTA.x * fraction, y: DRAG_DELTA.y * fraction };
}

export async function imageAsset(context, boardId) {
  const bytes = await sharp({ create: { width: 24, height: 16, channels: 3, background: { r: 80, g: 130, b: 180 } } }).png().toBuffer();
  const response = await context.post(`/api/boards/${boardId}/assets`, { multipart: {
    file: { name: "performance-fixture.png", mimeType: "image/png", buffer: bytes },
  } });
  if (!response.ok()) throw fail(`Fixture asset upload returned HTTP ${response.status()}`);
  return (await response.json()).asset.url;
}

export function seedScene(document, count, assetUrl) {
  const layers = document.getMap("layers");
  const order = document.getArray("layerIds");
  if (layers.size || order.length) throw fail("Performance fixture requires a newly created empty board");
  const positions = new Map();
  const types = {};
  const visibleTypes = {};
  document.transact(() => {
    for (let index = 0; index < count; index += 1) {
      const visible = index < VISIBLE_OBJECTS;
      const offset = visible ? index : index - VISIBLE_OBJECTS;
      const position = visible ? { x: 220 + offset % 25 * 40, y: 220 + Math.floor(offset / 25) * 32 }
        : { x: 5_000 + offset % 50 * 40, y: 5_000 + Math.floor(offset / 50) * 32 };
      const id = idAt(index);
      const slot = index % 10;
      const type = slot < 5 ? LayerType.Rectangle : slot < 7 ? LayerType.Ellipse
        : slot === 7 ? LayerType.Path : slot === 8 ? LayerType.Image : LayerType.Text;
      const layer = { type, ...position, width: 26, height: 22, fill: { r: 70, g: 110, b: 150 } };
      if (type === LayerType.Path) { layer.points = [[0, 15, 0.5], [7, 1, 0.6], [15, 20, 0.4], [26, 5, 0.5]]; layer.size = 2; }
      if (type === LayerType.Image) layer.src = assetUrl;
      if (type === LayerType.Text) {
        layer.fontSize = 8; layer.fontFamily = "Noto Sans";
        writeRichTextFragment(document.getXmlFragment(`text:${id}`), { type: "doc", content: [{ type: "paragraph", content: [
          { type: "text", text: "Ф " }, { type: "inlineMath", attrs: { latex: "x^2" } },
        ] }] });
      }
      layers.set(id, new Y.Map(Object.entries(layer)));
      positions.set(id, position);
      types[type] = (types[type] ?? 0) + 1;
      if (visible) visibleTypes[type] = (visibleTypes[type] ?? 0) + 1;
    }
    order.push([...positions.keys()]);
  }, "benchmark-fixture");
  return { positions, distribution: types, visibleDistribution: visibleTypes,
    objects: count, visibleObjects: Math.min(count, VISIBLE_OBJECTS), uniqueImages: 1, assetUrl, sceneVersion: SCENE_VERSION };
}
