// @vitest-environment node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { cpus, totalmem } from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium } from "playwright";

import { createPdfWorker } from "../export-worker/http";
import { inspectPdf } from "../export-worker/browser";
import { localPdfResources } from "../export-worker/resources";
import { renderPdfHtml } from "../export-worker/render";
import { pdfFixture } from "./pdf-fixtures";
import { plainTextDocument } from "../lib/board/rich-text/validation";
import { LayerType } from "../types/board-canvas";

describe.skipIf(process.env.RIMO_PDF_BROWSER_TEST !== "1")("isolated Chromium PDF worker", () => {
  const token = randomBytes(32).toString("base64url");
  const server = createPdfWorker(token);
  let origin: string;
  const directory = path.resolve("temp/pdf-acceptance");

  beforeAll(async () => {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    await mkdir(directory, { recursive: true });
  });
  afterAll(async () => { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); });

  it("requires an internal credential and rejects arbitrary network sources before Chromium", async () => {
    expect((await fetch(`${origin}/render`, { method: "POST", body: "{}" })).status).toBe(401);
    const source = pdfFixture(1);
    const job = { ...source, layers: [{ id: "text", layer: { type: 5, x: 0, y: 0, width: 10, height: 10, src: "http://127.0.0.1:3000/api/auth/session" } }] };
    const response = await fetch(`${origin}/render`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(job) });
    expect(response.status).toBe(400);
    expect(await (await fetch(`${origin}/healthz`)).json()).toMatchObject({ ok: true, waiting: 0 });
  });

  it("embeds all Cyrillic and KaTeX font resources locally", async () => {
    const css = await localPdfResources();
    expect(css).toContain("Noto Sans");
    expect(css).toContain("Noto Serif");
    expect(css).toContain("Noto Sans Mono");
    expect(css).toContain("data:font/woff2;base64,");
    expect(css).not.toMatch(/url\((?!data:)/);
  });

  it("measures real text/formula layout and emits a searchable 20-page PDF within 30 seconds", async () => {
    const source = pdfFixture(20);
    const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
    const inspect = await fetch(`${origin}/inspect`, { method: "POST", headers, body: JSON.stringify(source) });
    expect(inspect.status, await inspect.clone().text()).toBe(200);
    expect(await inspect.json()).toEqual({ warnings: [] });
    const started = performance.now();
    const response = await fetch(`${origin}/render`, { method: "POST", headers, body: JSON.stringify(source) });
    expect(response.status, response.ok ? "" : await response.clone().text()).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/pdf");
    const bytes = Buffer.from(await response.arrayBuffer());
    const durationMs = performance.now() - started;
    expect(bytes.toString("ascii", 0, 5)).toBe("%PDF-");
    expect(durationMs).toBeLessThan(30_000);
    await writeFile(path.join(directory, "rimo-control-20-pages.pdf"), bytes);
    const registry = JSON.parse(await readFile(path.resolve("node_modules/playwright-core/browsers.json"), "utf8")) as { browsers: { name: string; browserVersion?: string; revision: string }[] };
    const browser = registry.browsers.find((entry) => entry.name === "chromium");
    await writeFile(path.join(directory, "worker-result.json"), JSON.stringify({ pages: 20, durationMs: Math.round(durationMs), bytes: bytes.byteLength,
      node: process.version, platform: process.platform, architecture: process.arch, cpu: cpus()[0]?.model, logicalCpus: cpus().length,
      hostMemoryMiB: Math.round(totalmem() / 1024 / 1024), chromium: browser?.browserVersion, chromiumRevision: browser?.revision, revision: source.revision }, null, 2));
  }, 65_000);

  it("warns when an unbroken formula extends beyond a narrow frame", async () => {
    const source = pdfFixture(1);
    const text = source.layers[0];
    const job = { ...source, layers: [{ ...text, layer: { ...text.layer, width: 80, height: 20 } }], assets: [],
      pages: [{ ...source.pages[0], bounds: { x: 0, y: 0, width: 100, height: 100 }, layerIds: ["text"] }] };
    const response = await fetch(`${origin}/inspect`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(job) });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ warnings: [{ page: 0, code: "TEXT_OVERFLOW" }] });
  }, 35_000);

  it("terminates Chromium when a job is cancelled during startup", async () => {
    const started = performance.now();
    await expect(inspectPdf(pdfFixture(1), AbortSignal.timeout(30))).rejects.toBeDefined();
    expect(performance.now() - started).toBeLessThan(5_000);
  }, 10_000);

  it("contains an image with its original aspect ratio inside a differently resized layer", async () => {
    const source = pdfFixture(1);
    const image = source.layers.find((item) => item.id === "image")!;
    const job = { ...source, layers: [{ ...image, layer: { ...image.layer, x: 0, y: 0, width: 240, height: 60 } }],
      pages: [{ ...source.pages[0], bounds: { x: 0, y: 0, width: 240, height: 60 }, layerIds: ["image"] }] };
    const browser = await chromium.launch({ headless: true, timeout: 10_000, channel: process.env.PDF_WORKER_BROWSER_CHANNEL === "chromium" ? "chromium" : undefined,
      chromiumSandbox: process.env.PDF_CHROMIUM_SANDBOX !== "false" });
    try {
      const page = await browser.newPage({ javaScriptEnabled: false, offline: true });
      await page.setContent(renderPdfHtml(job, ""));
      const result = await page.evaluate(() => {
        const outer = document.querySelector("svg.object")!.getBoundingClientRect();
        const image = document.querySelector("svg.object use")!.getBoundingClientRect();
        return { outer: { width: outer.width, height: outer.height, left: outer.left }, image: { width: image.width, height: image.height, left: image.left } };
      });
      expect(result.outer.width / result.outer.height).toBeCloseTo(4, 2);
      expect(result.image.width / result.image.height).toBeCloseTo(80 / 60, 2);
      expect(result.image.left - result.outer.left).toBeCloseTo((result.outer.width - result.image.width) / 2, 1);
    } finally { await browser.close(); }
  }, 15_000);

  it("uses the same white foreground as the canvas for a medium gray sticker", async () => {
    const source = pdfFixture(1);
    const job = { ...source, assets: [], layers: [{ id: "sticker", layer: { type: LayerType.Sticker as const, x: 0, y: 0, width: 300, height: 120, fontSize: 20, fill: { r: 150, g: 150, b: 150 } }, richText: plainTextDocument("Серый стикер") }],
      pages: [{ ...source.pages[0], bounds: { x: 0, y: 0, width: 300, height: 120 }, layerIds: ["sticker"] }] };
    const browser = await chromium.launch({ headless: true, timeout: 10_000, channel: process.env.PDF_WORKER_BROWSER_CHANNEL === "chromium" ? "chromium" : undefined,
      chromiumSandbox: process.env.PDF_CHROMIUM_SANDBOX !== "false" });
    try {
      const page = await browser.newPage({ javaScriptEnabled: false, offline: true });
      await page.setContent(renderPdfHtml(job, ""));
      expect(await page.locator('[data-text-id="sticker"]').evaluate((element) => ({ color: getComputedStyle(element).color, background: getComputedStyle(element).backgroundColor })))
        .toEqual({ color: "rgb(255, 255, 255)", background: "rgb(150, 150, 150)" });
    } finally { await browser.close(); }
  }, 15_000);
});
