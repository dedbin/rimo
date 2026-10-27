// @vitest-environment node
import { describe, expect, it } from "vitest";

import { pageMetrics } from "../export-worker/contract";
import { renderPdfHtml } from "../export-worker/render";
import { parsePdfJob, parsePdfRequest } from "../export-worker/validation";
import { boundsForLayers, normalizeFrameOrder, parseFrame } from "../lib/board/frames";
import { pdfWarnings } from "../server/exports/warnings";
import { LayerType } from "../types/board-canvas";
import { pdfFixture } from "./pdf-fixtures";

describe("PDF document boundary", () => {
  it("accepts bounded named frames and normalizes CRDT order references", () => {
    const frame = parseFrame({ name: " Урок 1 ", x: -10, y: 2, width: 300, height: 400 });
    expect(frame?.name).toBe("Урок 1");
    expect(parseFrame({ ...frame, width: 0 })).toBeNull();
    expect(parseFrame({ ...frame, name: "Урок\nдва" })).toBeNull();
    const frames = new Map([["b", frame!], ["a", frame!]]);
    expect(normalizeFrameOrder(["b", "missing", "b"], frames)).toEqual(["b", "a"]);
  });

  it("includes pencil stroke extent in the selected region", () => {
    const bounds = boundsForLayers([{ type: LayerType.Path, x: 0, y: 0, width: 100, height: 0, size: 16, fill: { r: 0, g: 0, b: 0 }, points: [[0, 0], [100, 0]] }], 0);
    expect(bounds).toEqual({ x: -16, y: -16, width: 132, height: 33 });
  });

  it("preserves page order and different paper settings", () => {
    const job = parsePdfJob(pdfFixture());
    expect(job.pages.map((page) => page.name)).toEqual(["Задача", "Решение 1"]);
    expect(pageMetrics(job.pages[0]).height).toBeGreaterThan(pageMetrics(job.pages[0]).width);
    expect(pageMetrics(job.pages[1]).width).toBeGreaterThan(pageMetrics(job.pages[1]).height);
    expect(parsePdfRequest({ minimumRevision: 42, pages: [{ source: { type: "selection", layerIds: ["text", "text"] }, format: "A4", orientation: "portrait" }] }).pages[0].source).toEqual({ type: "selection", layerIds: ["text"] });
  });

  it("rejects arbitrary HTML, external images, unknown layers and more than 20 pages", () => {
    const source = pdfFixture();
    expect(() => parsePdfJob({ ...source, pages: Array(21).fill(source.pages[0]) })).toThrow();
    expect(() => parsePdfJob({ ...source, layers: [{ id: "image", layer: { type: LayerType.Image, x: 0, y: 0, width: 10, height: 10, src: "http://169.254.169.254/secret" } }] })).toThrow();
    expect(() => parsePdfJob({ ...source, layers: [{ id: "text", layer: source.layers[0].layer, richText: { type: "doc", content: [{ type: "html", text: "<script>" }] } }] })).toThrow();
    expect(() => parsePdfJob({ ...source, layers: [{ id: "text", layer: { ...source.layers[0].layer, type: "plugin" } }] })).toThrow();
  });

  it("escapes every user string and emits generated math rather than an entire screenshot", () => {
    const source = pdfFixture(1);
    const job = parsePdfJob({ ...source, title: "<script>alert(1)</script>", layers: [{ ...source.layers[0], richText: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "<img src=x onerror=alert(1)>" }] }, { type: "blockMath", attrs: { latex: "x^2 + y^2" } }] } }] , pages: [{ ...source.pages[0], layerIds: ["text"] }] });
    const html = renderPdfHtml(job, "/* local fonts */");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(html).toContain('class="katex"');
    expect(html).not.toContain("<script");
    expect(html).not.toContain("<canvas");
    expect(html).toContain("connect-src 'none'");
  });

  it("reports small paper text and explicit clipping of a frame", () => {
    const source = pdfFixture(1);
    const job = { ...source, pages: [{ ...source.pages[0], bounds: { x: 40, y: 40, width: 6000, height: 6000 } }] };
    expect(pdfWarnings(job).map((warning) => warning.code)).toEqual(["SMALL_TEXT", "CLIPPED_OBJECT"]);
  });

  it("embeds an image once when it appears on multiple pages", () => {
    const job = parsePdfJob(pdfFixture(20));
    const html = renderPdfHtml(job, "");
    expect(html.match(/data:image\/webp;base64,/g)).toHaveLength(1);
    expect(html.match(/href="#pdf-asset-0"/g)).toHaveLength(20);
  });

  it("bounds repeated rendering work even if the serialized job is small", () => {
    const source = pdfFixture(20);
    const layers = Array.from({ length: 1100 }, (_, index) => ({ id: `rect-${index}`, layer: source.layers[1].layer }));
    expect(() => parsePdfJob({ ...source, layers, assets: [], pages: source.pages.map((page) => ({ ...page, layerIds: layers.map((item) => item.id) })) })).toThrow(/Слишком много сложных/);
  });

  it("uses the shared font whitelist and never interpolates a user's CSS family", () => {
    const source = pdfFixture(1);
    const job = parsePdfJob({ ...source, layers: source.layers.map((item) => item.id === "text" ? { ...item, layer: { ...item.layer, fontFamily: "evil';background:url(https://evil.test)" } } : item) });
    const html = renderPdfHtml(job, "");
    expect(html).toContain("font-family:'Noto Sans'");
    expect(html).toContain("font-family:'Noto Serif'");
    expect(html).toContain("font-family:'Noto Sans Mono'");
    expect(html).not.toContain("evil.test");
  });
});
