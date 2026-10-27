import type { PdfJob } from "../export-worker/contract";
import { LayerType } from "../types/board-canvas";

export function pdfFixture(pageCount = 2): PdfJob {
  return {
    version: 1, title: "Математика: контрольный урок", revision: 42, savedAt: "2026-10-27T10:00:00.000Z",
    layers: [
      { id: "text", layer: { type: LayerType.Text, x: 30, y: 30, width: 540, height: 190, fontSize: 22, fill: { r: 15, g: 23, b: 42 } },
        richText: { type: "doc", content: [
          { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Квадратное уравнение" }] },
          { type: "paragraph", content: [{ type: "text", text: "Найдите корни и объясните решение.", marks: [{ type: "bold" }] }] },
          { type: "paragraph", content: [{ type: "text", text: "Проверка: ", marks: [{ type: "italic" }] }, { type: "inlineMath", attrs: { latex: "x^2-5x+6=0" } }] },
          { type: "blockMath", attrs: { latex: "x_{1,2}=\\frac{5\\pm\\sqrt{25-24}}{2}" } },
        ] } },
      { id: "rect", layer: { type: LayerType.Rectangle, x: 30, y: 260, width: 220, height: 160, fill: { r: 224, g: 242, b: 254 }, stroke: { r: 3, g: 105, b: 161 }, strokeWidth: 2 } },
      { id: "ellipse", layer: { type: LayerType.Ellipse, x: 290, y: 260, width: 220, height: 160, fill: { r: 220, g: 252, b: 231 }, stroke: { r: 21, g: 128, b: 61 }, strokeWidth: 2 } },
      { id: "path", layer: { type: LayerType.Path, x: 30, y: 460, width: 480, height: 30, fill: { r: 220, g: 38, b: 38 }, points: [[0, 0, 0.5], [100, 25, 0.5], [240, 5, 0.5], [480, 30, 0.5]], size: 4 } },
      { id: "image", layer: { type: LayerType.Image, x: 530, y: 270, width: 50, height: 38, src: "/api/assets/fixture-image" } },
      { id: "serif", layer: { type: LayerType.Text, x: 30, y: 510, width: 260, height: 110, fontSize: 16, fontFamily: "Noto Serif", fill: { r: 0, g: 0, b: 0 } }, richText: { type: "doc", content: [
        { type: "paragraph", content: [{ type: "text", text: "Шрифт с засечками" }] },
        { type: "paragraph", content: [{ type: "text", text: "Жирный ", marks: [{ type: "bold" }] }, { type: "text", text: "курсив", marks: [{ type: "italic" }] }] },
        { type: "paragraph", content: [{ type: "text", text: "код_по_русски = 3", marks: [{ type: "code" }] }] },
      ] } },
      { id: "mono", layer: { type: LayerType.Text, x: 290, y: 510, width: 280, height: 110, fontSize: 16, fontFamily: "Noto Sans Mono", fill: { r: 0, g: 0, b: 0 } }, richText: { type: "doc", content: [
        { type: "paragraph", content: [{ type: "text", text: "Моноширинный текст" }] },
        { type: "paragraph", content: [{ type: "text", text: "Жирный ", marks: [{ type: "bold" }] }, { type: "text", text: "курсив", marks: [{ type: "italic" }] }] },
        { type: "paragraph", content: [{ type: "text", text: "печать(2 + 3)", marks: [{ type: "code" }] }] },
      ] } },
    ],
    assets: [{ id: "fixture-image", width: 80, height: 60, data: "UklGRk4AAABXRUJQVlA4IEIAAADwAwCdASpQADwAPm02mUmkIyKhIagAgA2JaQB2AAAbZ70kCBAgQICQAP7svY//+wd/+g7/9B3+qZ/5GQ25gAAAAAA=" }],
    pages: Array.from({ length: pageCount }, (_, index) => ({ name: index === 0 ? "Задача" : `Решение ${index}`,
      format: index % 2 ? "A3" : "A4", orientation: index % 2 ? "landscape" : "portrait",
      bounds: { x: 0, y: 0, width: 600, height: 650 }, layerIds: ["text", "rect", "ellipse", "path", "image", "serif", "mono"] })),
  };
}
