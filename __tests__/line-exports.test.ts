// @vitest-environment node
import { describe, expect, it } from "vitest";

import type { PdfJob } from "../export-worker/contract";
import { renderPdfHtml } from "../export-worker/render";
import { parsePdfJob } from "../export-worker/validation";
import { boundsForLayers, layerIntersectsBounds, visualBounds } from "../lib/board/frames";
import { createLine } from "../lib/board/line";
import type { LineLayer, XYWH } from "../types/board-canvas";

const color = { r: 15, g: 23, b: 42 };
const pageBounds = { x: 100, y: 20, width: 300, height: 200 };

function jobForLine(layer: LineLayer, bounds: XYWH = pageBounds): PdfJob {
  return parsePdfJob({ version: 1, title: "Оси и многоугольники", revision: 1,
    savedAt: "2026-10-29T10:00:00.000Z", layers: [{ id: "line", layer }], assets: [],
    pages: [{ name: "Урок", format: "A4", orientation: "portrait", bounds, layerIds: ["line"] }],
  });
}

function renderedLine(html: string): Record<string, number> {
  const element = html.match(/<line\b[^>]*\/>/)?.[0];
  expect(element).toBeDefined();
  return Object.fromEntries([...element!.matchAll(/(x1|y1|x2|y2|stroke-width)="([^"]+)"/g)]
    .map((match) => [match[1], Number(match[2])]));
}

describe("line frame geometry", () => {
  it("includes arrowheads in selection export bounds for horizontal and vertical segments", () => {
    const horizontal = { ...createLine({ x: 100, y: 80 }, { x: 300, y: 80 }, color),
      strokeWidth: 4, startArrow: true, endArrow: true };
    expect(visualBounds(horizontal)).toEqual({ x: 84, y: 64, width: 232, height: 33 });
    const vertical = { ...createLine({ x: 100, y: 80 }, { x: 100, y: 280 }, color),
      strokeWidth: 2, endArrow: true };
    expect(boundsForLayers([vertical], 0)).toEqual({ x: 90, y: 70, width: 21, height: 220 });
  });

  it("finds infinite lines crossing a frame when both anchors are outside it", () => {
    const line = createLine({ x: -500, y: 80 }, { x: -400, y: 80 }, color, "line");
    expect(layerIntersectsBounds(line, pageBounds)).toBe(true);
    expect(layerIntersectsBounds({ ...line, lineKind: "segment" }, pageBounds)).toBe(false);
    expect(layerIntersectsBounds({ ...line, y: 500 }, pageBounds)).toBe(false);
  });

  it("includes a line whose painted stroke overlaps the frame edge", () => {
    const line = { ...createLine({ x: 99, y: -100 }, { x: 99, y: -50 }, color, "line"), strokeWidth: 4 };
    expect(layerIntersectsBounds(line, pageBounds)).toBe(true);
    expect(layerIntersectsBounds({ ...line, x: 97 }, pageBounds)).toBe(false);
  });
});

describe("vector line PDF output", () => {
  it("exports a horizontal segment and both arrowheads without a zero-height viewBox", () => {
    const layer = { ...createLine({ x: 120, y: 80 }, { x: 350, y: 80 }, color),
      strokeWidth: 4, startArrow: true, endArrow: true };
    const html = renderPdfHtml(jobForLine(layer), "");
    expect(renderedLine(html)).toEqual({ x1: 120, y1: 80, x2: 350, y2: 80, "stroke-width": 4 });
    expect(html.match(/<polygon\b/g)).toHaveLength(2);
    expect(html).toContain('viewBox="100 20 300 200"');
    expect(html).toContain('stroke="rgba(15,23,42,1)"');
    expect(html).not.toContain("<canvas");
  });

  it("preserves vertical segment direction and a single arrow through the PDF contract", () => {
    const layer = { ...createLine({ x: 240, y: 180 }, { x: 240, y: 40 }, color), startArrow: true };
    const html = renderPdfHtml(jobForLine(layer), "");
    const line = renderedLine(html);
    expect([line.x1, line.y1, line.x2, line.y2]).toEqual([240, 180, 240, 40]);
    expect(html.match(/<polygon\b/g)).toHaveLength(1);
  });

  it("extends an infinite line to the PDF page instead of its distant anchor bounds", () => {
    const layer = { ...createLine({ x: -500, y: 80 }, { x: -400, y: 80 }, color, "line"), strokeWidth: 2 };
    const html = renderPdfHtml(jobForLine(layer), "");
    const line = renderedLine(html);
    expect([line.x1, line.y1, line.x2, line.y2]).toEqual([99, 80, 401, 80]);
    expect(html).not.toContain("<polygon");
  });

  it("does not render a parallel infinite line outside the page", () => {
    const layer = createLine({ x: -500, y: 500 }, { x: -400, y: 500 }, color, "line");
    expect(renderPdfHtml(jobForLine(layer), "")).not.toContain("<line ");
  });
});
