// @vitest-environment node
import { describe, expect, it } from "vitest";
import * as Y from "yjs";

import { initializeDocument, validateDocument } from "../collaboration-server/document";
import { DEFAULT_LIMITS } from "../collaboration-server/types";
import { renderPdfHtml } from "../export-worker/render";
import { parsePdfJob } from "../export-worker/validation";
import { createLine, lineDashPattern } from "../lib/board/line";
import { BoardDocument } from "../lib/collaboration/document";
import { portableBoard } from "../server/archive/portable";
import type { LineLayer } from "../types/board-canvas";

const color = { r: 15, g: 23, b: 42 };

function pdfFor(layer: LineLayer): string {
  return renderPdfHtml(parsePdfJob({ version: 1, title: "Пунктир", revision: 1,
    savedAt: "2026-11-01T12:00:00.000Z", layers: [{ id: "line", layer }], assets: [],
    pages: [{ name: "Построение", format: "A4", orientation: "portrait",
      bounds: { x: 5, y: 10, width: 300, height: 200 }, layerIds: ["line"] }],
  }), "");
}

describe("dashed line portable archive and export", () => {
  it("keeps the style in the validated native state and portable archive", () => {
    const document = new Y.Doc();
    initializeDocument(document);
    const board = new BoardDocument(document);
    const restored = new Y.Doc();
    try {
      const layer = createLine({ x: 20, y: 40 }, { x: 200, y: 60 }, color, "segment", "dashed");
      const [id] = board.insert([layer]);
      const portable = JSON.parse(portableBoard(document).toString("utf8"));
      expect(portable.layers[id]).toMatchObject({ strokeStyle: "dashed" });
      Y.applyUpdate(restored, validateDocument(document, DEFAULT_LIMITS));
      expect(JSON.parse(portableBoard(restored).toString("utf8"))).toEqual(portable);
      document.getMap<Y.Map<unknown>>("layers").get(id)!.set("strokeStyle", "invalid");
      expect(() => validateDocument(document, DEFAULT_LIMITS)).toThrow("Invalid board object");
    } finally { board.destroy(); restored.destroy(); }
  });

  it.each(["segment", "line"] as const)("uses the same dash metrics in SVG output and PDF for %s", (kind) => {
    const layer = { ...createLine({ x: 20, y: 50 }, { x: 200, y: 50 }, color, kind, "dashed"),
      strokeWidth: 4, startArrow: true, endArrow: true };
    const html = pdfFor(layer);
    const body = html.match(/<line\b[^>]*\/>/)?.[0];
    expect(body).toBeDefined();
    const start = { x: Number(body!.match(/x1="([^"]+)"/)?.[1]), y: 50 };
    const pattern = lineDashPattern(layer, start)!;
    expect(body).toContain(`stroke-dasharray="${pattern.array}"`);
    expect(body).toContain(`stroke-dashoffset="${pattern.offset}"`);
    const arrows = html.match(/<polygon\b[^>]*\/>/g) ?? [];
    expect(arrows).toHaveLength(kind === "segment" ? 2 : 0);
    expect(arrows.every((arrow) => !arrow.includes("stroke-dash"))).toBe(true);
  });

  it("preserves legacy solid output and rejects invalid style before rendering PDF", () => {
    const layer = createLine({ x: 20, y: 50 }, { x: 200, y: 50 }, color);
    delete layer.strokeStyle;
    expect(pdfFor(layer)).not.toContain("stroke-dash");
    expect(() => pdfFor({ ...layer, strokeStyle: "invalid" } as unknown as LineLayer)).toThrow();
  });
});
