import { chromium } from "playwright";
import type { BrowserServer, Page } from "playwright";

import { MAX_PDF_BYTES, PdfJobError } from "./contract";
import type { PdfJob, PdfWarning } from "./contract";
import { renderPdfHtml } from "./render";
import { localPdfResources } from "./resources";
import { closeBrowser, terminateBrowser } from "./terminate";

async function overflowWarnings(page: Page): Promise<PdfWarning[]> {
  const overflowing = await page.evaluate(() => [...document.querySelectorAll<HTMLElement>("section[data-page]")].flatMap((sheet) => {
    const clip = sheet.querySelector<HTMLElement>("[data-clip]")!.getBoundingClientRect();
    const texts = [...sheet.querySelectorAll<HTMLElement>("[data-text-id]")];
    const overflow = texts.some((element) => {
      const rect = element.getBoundingClientRect();
      if (element.scrollHeight > Number(element.dataset.height) + 2 || element.scrollWidth > element.clientWidth + 2 ||
          rect.left < clip.left - 1 || rect.right > clip.right + 1 || rect.top < clip.top - 1 || rect.bottom > clip.bottom + 1) return true;
      return [...element.querySelectorAll<HTMLElement>(".katex")].some((math) => {
        const bounds = math.getBoundingClientRect();
        return bounds.left < clip.left - 1 || bounds.right > clip.right + 1 || bounds.top < clip.top - 1 || bounds.bottom > clip.bottom + 1;
      });
    });
    return overflow ? [Number(sheet.dataset.page)] : [];
  }));
  return overflowing.map((index) => ({ page: index, code: "TEXT_OVERFLOW", message: `Страница ${index + 1}: текст или формула выходит за сохранённые границы. Проверьте предпросмотр, расширьте текстовый блок или фрейм.` }));
}

async function withBrowser<T>(job: PdfJob, signal: AbortSignal, operation: (page: Page) => Promise<T>): Promise<T> {
  signal.throwIfAborted();
  let browserServer: BrowserServer | undefined;
  const launch = chromium.launchServer({ headless: true, host: "127.0.0.1", timeout: 20_000, chromiumSandbox: process.env.PDF_CHROMIUM_SANDBOX !== "false",
    channel: process.env.PDF_WORKER_BROWSER_CHANNEL === "chromium" ? "chromium" : undefined,
    args: ["--disable-dev-shm-usage", "--disable-background-networking", "--disable-component-update", "--disable-domain-reliability", "--no-pings"] });
  const close = (): void => { if (browserServer) void terminateBrowser(browserServer).catch(() => undefined); };
  signal.addEventListener("abort", close, { once: true });
  try {
    browserServer = await launch;
    signal.throwIfAborted();
    const browser = await chromium.connect(browserServer.wsEndpoint(), { timeout: 5_000 });
    const context = await browser.newContext({ javaScriptEnabled: false, serviceWorkers: "block", acceptDownloads: false, offline: true });
    await context.route("**/*", (route) => route.abort("blockedbyclient"));
    const page = await context.newPage();
    page.setDefaultTimeout(20_000);
    page.setDefaultNavigationTimeout(20_000);
    await page.emulateMedia({ media: "print", reducedMotion: "reduce" });
    await page.setContent(renderPdfHtml(job, await localPdfResources()), { waitUntil: "load", timeout: 20_000 });
    await page.evaluate(async () => {
      const required = ["Noto Sans", "Noto Serif", "Noto Sans Mono"].flatMap((family) => [400, 700].flatMap((weight) =>
        ["normal", "italic"].map((style) => `${style} ${weight} 16px '${family}'`),
      ));
      await Promise.all(required.map((font) => document.fonts.load(font, "Русский текст Latin")));
      await document.fonts.ready;
      if (required.some((font) => !document.fonts.check(font, "Русский текст"))) throw new Error("Local Cyrillic fonts are unavailable");
      await Promise.all([...document.querySelectorAll<SVGImageElement>("image[data-asset]")].map(async (asset) => {
        const image = new Image();
        image.src = asset.href.baseVal;
        await image.decode();
        if (image.naturalWidth < 1) throw new Error("An export image could not be decoded");
      }));
    });
    signal.throwIfAborted();
    return await operation(page);
  } catch (error) {
    if (signal.aborted) throw signal.reason;
    throw error;
  } finally {
    signal.removeEventListener("abort", close);
    if (browserServer) await closeBrowser(browserServer);
  }
}

export async function inspectPdf(job: PdfJob, signal: AbortSignal): Promise<readonly PdfWarning[]> {
  return withBrowser(job, signal, overflowWarnings);
}

export async function printPdf(job: PdfJob, signal: AbortSignal): Promise<Buffer> {
  return withBrowser(job, signal, async (page) => {
    const bytes = await page.pdf({ preferCSSPageSize: true, printBackground: true, tagged: true });
    if (bytes.byteLength > MAX_PDF_BYTES) throw new PdfJobError(413, "PDF_TOO_LARGE", "Получился слишком большой PDF. Уменьшите число страниц.");
    return bytes;
  });
}
