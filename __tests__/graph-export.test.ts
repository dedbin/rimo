// @vitest-environment node
import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";
import * as Y from "yjs";

import { initializeDocument, validateDocument } from "../collaboration-server/document";
import { DEFAULT_LIMITS } from "../collaboration-server/types";
import { MAX_PDF_GRAPH_EXPRESSIONS, pageMetrics } from "../export-worker/contract";
import type { PdfJob } from "../export-worker/contract";
import { renderPdfHtml } from "../export-worker/render";
import { parsePdfJob } from "../export-worker/validation";
import { GRAPH_CSS } from "../lib/board/graph/styles";
import { createLayer } from "../lib/board/model";
import { BoardDocument } from "../lib/collaboration/document";
import { portableBoard } from "../server/archive/portable";
import { LayerType } from "../types/board-canvas";
import type { GraphLayer } from "../types/board-canvas";

function graphFixture(count = 4): GraphLayer {
  const layer = createLayer(LayerType.Graph, { x: 20, y: 30 }, { r: 0, g: 0, b: 0 });
  if (layer.type !== LayerType.Graph) throw new Error("Expected graph layer");
  const formulas = ["y = x^2", "y = sin(x)", "y < x + 1", "x >= 2"];
  const colors = ["#2563eb", "#dc2626", "#059669", "#9333ea"];
  layer.graph.expressions = Object.fromEntries(Array.from({ length: count }, (_, index) => [`curve_${index}`, {
    formula: formulas[index % formulas.length], color: colors[index % colors.length], visible: true, order: index,
  }]));
  return layer;
}

function jobFor(graphs: readonly GraphLayer[], pageCount = 1, selected?: readonly string[]): PdfJob {
  const layers = graphs.map((layer, index) => ({ id: `graph_${index}`, layer }));
  return {
    version: 1, title: "Графики и неравенства", revision: 4, savedAt: "2026-11-01T12:00:00.000Z",
    layers, assets: [],
    pages: Array.from({ length: pageCount }, (_, index) => ({
      name: `Функции ${index + 1}`, format: "A4", orientation: "landscape",
      bounds: { x: 0, y: 0, width: 1600, height: 1000 }, layerIds: selected ?? layers.map((item) => item.id),
    })),
  };
}

function withMarkup(html: string, check: (document: Document) => void): void {
  const dom = new JSDOM(html);
  try { check(dom.window.document); }
  finally { dom.window.close(); }
}

describe("graph vector PDF output", () => {
  it("renders multiple curves and both inequality directions without scripts or raster screenshots", () => {
    const html = renderPdfHtml(parsePdfJob(jobFor([graphFixture()])), "");
    withMarkup(html, (document) => {
      expect(document.querySelectorAll("[data-graph-plot]")).toHaveLength(1);
      expect(document.querySelectorAll("[data-graph-expression]")).toHaveLength(4);
      expect(document.querySelectorAll("[data-graph-shading]")).toHaveLength(2);
      expect(document.querySelectorAll("script,canvas,img,foreignObject")).toHaveLength(0);
      const lower = document.querySelector('[data-graph-expression="curve_2"]')!;
      const right = document.querySelector('[data-graph-expression="curve_3"]')!;
      expect(lower.getAttribute("data-graph-axis")).toBe("y");
      expect(lower.getAttribute("data-graph-operator")).toBe("<");
      expect(lower.querySelector('path[stroke-dasharray="4,8"]')).not.toBeNull();
      expect(lower.innerHTML).toContain("#059669");
      expect(right.getAttribute("data-graph-axis")).toBe("x");
      expect(right.getAttribute("data-graph-operator")).toBe(">=");
      expect(right.querySelector('path[stroke-dasharray="4,8"]')).toBeNull();
      expect(right.innerHTML).toContain("#9333ea");
      const paths = [...document.querySelectorAll("[data-graph-expression] path")];
      expect(paths.length).toBeGreaterThanOrEqual(6);
      expect(paths.every((path) => Boolean(path.getAttribute("d")) && !/NaN|Infinity/.test(path.getAttribute("d")!))).toBe(true);
      expect(document.querySelectorAll(".mafs-axis text").length).toBeGreaterThan(0);
    });
    expect(html).toContain("connect-src 'none'");
    expect(html.split(GRAPH_CSS)).toHaveLength(2);
  });

  it("omits hidden or unsafe formulas while still rendering valid neighbouring curves", () => {
    const graph = graphFixture();
    graph.graph.expressions.curve_1.visible = false;
    graph.graph.expressions.curve_2.formula = '<img src=x onerror="alert(1)">';
    graph.graph.expressions.curve_3.formula = "y =";
    const html = renderPdfHtml(parsePdfJob(jobFor([graph])), "");
    withMarkup(html, (document) => {
      const expressions = [...document.querySelectorAll("[data-graph-expression]")];
      expect(expressions.map((element) => element.getAttribute("data-graph-expression"))).toEqual(["curve_0"]);
      expect(expressions[0].querySelector("path")).not.toBeNull();
      expect(document.querySelectorAll("script,img,[onerror]")).toHaveLength(0);
    });
    expect(html).not.toContain('<img src=x onerror="alert(1)">');
  });

  it("bounds mathematical render resolution while preserving a large block's printed rectangle", () => {
    const graph = { ...graphFixture(1), width: 1920, height: 1440 };
    const job = parsePdfJob(jobFor([graph]));
    const scale = pageMetrics(job.pages[0]).scale;
    withMarkup(renderPdfHtml(job, ""), (document) => {
      const outer = document.querySelector<HTMLElement>("[data-graph-id]")!;
      const plot = outer.querySelector<HTMLElement>("[data-graph-plot]")!;
      const svg = plot.querySelector("svg")!;
      const logicalWidth = Number(svg.getAttribute("width"));
      const logicalHeight = Number(svg.getAttribute("height"));
      expect(logicalWidth).toBe(960);
      expect(logicalHeight).toBe(720);
      expect(parseFloat(outer.style.width)).toBeCloseTo(graph.width * scale, 8);
      expect(parseFloat(outer.style.height)).toBeCloseTo(graph.height * scale, 8);
      expect(parseFloat(outer.style.left)).toBeCloseTo(graph.x * scale, 8);
      expect(parseFloat(outer.style.top)).toBeCloseTo(graph.y * scale, 8);
      const transform = /scale\(([^,]+),\s*([^)]+)\)/.exec(plot.parentElement!.style.transform);
      expect(transform).not.toBeNull();
      expect(logicalWidth * Number(transform![1])).toBeCloseTo(parseFloat(outer.style.width), 8);
      expect(logicalHeight * Number(transform![2])).toBeCloseTo(parseFloat(outer.style.height), 8);
    });
  });

  it("gives every repeated graph independent clip definitions across blocks and pages", () => {
    const first = graphFixture();
    const second = graphFixture();
    second.graph.showGrid = false;
    const html = renderPdfHtml(parsePdfJob(jobFor([first, second], 2)), "");
    withMarkup(html, (document) => {
      const plots = [...document.querySelectorAll("[data-graph-plot]")];
      expect(plots).toHaveLength(4);
      expect(plots.map((plot) => plot.getAttribute("data-graph-grid"))).toEqual(["true", "false", "true", "false"]);
      const clipIds = [...document.querySelectorAll("clipPath[id]")].map((clip) => clip.id);
      expect(clipIds.length).toBeGreaterThan(0);
      expect(new Set(clipIds).size).toBe(clipIds.length);
      for (const plot of plots) {
        for (const element of plot.querySelectorAll("[clip-path]")) {
          const id = /^url\(#(.+)\)$/.exec(element.getAttribute("clip-path")!)?.[1];
          expect(id).toBeDefined();
          expect(plot.contains(document.getElementById(id!))).toBe(true);
        }
      }
    });
  });
});

describe("graph archive compatibility", () => {
  it("preserves graph expressions, ranges and visibility in validated portable and native state", () => {
    const document = new Y.Doc();
    initializeDocument(document);
    const board = new BoardDocument(document);
    const restored = new Y.Doc();
    try {
      const graph = graphFixture();
      graph.graph.viewport = { xMin: -12, xMax: 4, yMin: -2, yMax: 10 };
      graph.graph.showGrid = false;
      graph.graph.expressions.curve_1.visible = false;
      const [id] = board.insert([graph]);
      const portable = JSON.parse(portableBoard(document).toString("utf8")) as { layers: Record<string, GraphLayer> };
      expect(portable.layers[id]).toEqual(graph);
      Y.applyUpdate(restored, validateDocument(document, DEFAULT_LIMITS));
      expect(JSON.parse(portableBoard(restored).toString("utf8"))).toEqual(portable);
      const restoredLayer = restored.getMap<Y.Map<unknown>>("layers").get(id)!.toJSON() as GraphLayer;
      const html = renderPdfHtml(parsePdfJob(jobFor([restoredLayer])), "");
      withMarkup(html, (htmlDocument) => {
        expect(htmlDocument.querySelectorAll("[data-graph-expression]")).toHaveLength(3);
        expect(htmlDocument.querySelector("[data-graph-grid]")!.getAttribute("data-graph-grid")).toBe("false");
      });
    } finally { board.destroy(); restored.destroy(); }
  });
});

describe("graph PDF work limits", () => {
  it("accepts exactly the expression budget and rejects repeated work on one extra page", () => {
    expect(MAX_PDF_GRAPH_EXPRESSIONS).toBe(64);
    expect(() => parsePdfJob(jobFor([graphFixture(8)], 8))).not.toThrow();
    expect(() => parsePdfJob(jobFor([graphFixture(8)], 9))).toThrow(expect.objectContaining({ status: 413, code: "PDF_TOO_COMPLEX" }));
  });

  it("adds the expression cost of distinct blocks on the same page", () => {
    expect(() => parsePdfJob(jobFor(Array.from({ length: 5 }, () => graphFixture(12))))).not.toThrow();
    expect(() => parsePdfJob(jobFor(Array.from({ length: 6 }, () => graphFixture(12)))))
      .toThrow(expect.objectContaining({ status: 413, code: "PDF_TOO_COMPLEX" }));
  });

  it("does not charge hidden, blank or unselected expressions against the rendering budget", () => {
    const graph = graphFixture(12);
    Object.values(graph.graph.expressions).forEach((expression, index) => {
      expression.visible = index < 2;
      if (index === 1) expression.formula = "   ";
    });
    expect(() => parsePdfJob(jobFor([graph], 20))).not.toThrow();
    const unused = Array.from({ length: 6 }, () => graphFixture(12));
    expect(() => parsePdfJob(jobFor(unused, 1, ["graph_0"]))).not.toThrow();
  });
});
