import getStroke from "perfect-freehand";

import { resolveBoardFont } from "../lib/board/fonts";
import { getContrastingTextColor, rgbToCss } from "../lib/board/colors";
import { LayerType } from "../types/board-canvas";
import type { Layer } from "../types/board-canvas";
import { MAX_PDF_HTML_BYTES, pageMetrics, PDF_FORMATS, PdfJobError } from "./contract";
import type { PdfJob, PdfLayer, PdfPage } from "./contract";
import { escapeHtml, renderPdfRichText } from "./rich-text";

export const PDF_CONTENT_POLICY = "default-src 'none'; img-src data:; font-src data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; connect-src 'none'; object-src 'none'";

interface Placement { readonly bounds: PdfPage["bounds"]; readonly scale: number }
function position(layer: Layer, placement: Placement): string {
  const { bounds, scale } = placement;
  return `left:${(layer.x - bounds.x) * scale}px;top:${(layer.y - bounds.y) * scale}px;width:${Math.max(1, layer.width) * scale}px;height:${Math.max(1, layer.height) * scale}px;`;
}
function pathData(points: number[][]): string {
  if (!points.length) return "";
  return `M${points[0][0]},${points[0][1]} ${points.map(([x, y], index) => {
    const next = points[(index + 1) % points.length];
    return `Q${x},${y},${(x + next[0]) / 2},${(y + next[1]) / 2}`;
  }).join(" ")} Z`;
}

function shape(layer: Layer, placement: Placement): string {
  const width = Math.max(1, layer.width);
  const height = Math.max(1, layer.height);
  if (layer.type === LayerType.Path) {
    const outline = getStroke(layer.points, { size: layer.size ?? 16, thinning: 0.5, smoothing: 0.5, streamline: 0.5 });
    return `<svg class="object vector" style="${position(layer, placement)}" viewBox="0 0 ${width} ${height}"><path d="${pathData(outline)}" fill="${rgbToCss(layer.fill)}"/></svg>`;
  }
  if (layer.type !== LayerType.Rectangle && layer.type !== LayerType.Ellipse) return "";
  const paint = `fill="${rgbToCss(layer.fill)}" stroke="${layer.stroke ? rgbToCss(layer.stroke) : "transparent"}" stroke-width="${layer.strokeWidth ?? 0}"`;
  const element = layer.type === LayerType.Rectangle ? `<rect width="${width}" height="${height}" ${paint}/>` :
    `<ellipse cx="${width / 2}" cy="${height / 2}" rx="${width / 2}" ry="${height / 2}" ${paint}/>`;
  return `<svg class="object vector" style="${position(layer, placement)}" viewBox="0 0 ${width} ${height}">${element}</svg>`;
}

function renderLayer(item: PdfLayer, assets: ReadonlyMap<string, { key: string; width: number; height: number }>, placement: Placement): string {
  const { layer } = item;
  const { scale } = placement;
  if (layer.type === LayerType.Text || layer.type === LayerType.Sticker) {
    const sticker = layer.type === LayerType.Sticker;
    const foreground = sticker ? getContrastingTextColor(layer.fill) : rgbToCss(layer.fill);
    const minimumHeight = Math.max(layer.height, sticker ? 100 : Math.ceil(layer.fontSize * 1.4) + 8);
    return `<div class="object rich-text" data-text-id="${escapeHtml(item.id)}" data-height="${layer.height * scale}" style="${position(layer, placement)}height:auto;min-height:${minimumHeight * scale}px;padding:${4 * scale}px ${8 * scale}px;font-size:${layer.fontSize * scale}px;font-family:'${resolveBoardFont(layer.fontFamily)}';color:${foreground};${sticker ? `background:${rgbToCss(layer.fill)};` : ""}">${item.richText ? renderPdfRichText(item.richText) : ""}</div>`;
  }
  if (layer.type === LayerType.Image) {
    const asset = assets.get(layer.src.slice("/api/assets/".length))!;
    return `<svg class="object" style="${position(layer, placement)}" viewBox="0 0 ${asset.width} ${asset.height}" preserveAspectRatio="xMidYMid meet"><use href="#${asset.key}"/></svg>`;
  }
  if (layer.type === LayerType.LinkPreview) {
    return `<div class="object link-card" style="${position(layer, placement)}font-size:${14 * scale}px;padding:${14 * scale}px;border-width:${scale}px;border-radius:${12 * scale}px"><strong>${escapeHtml(layer.title || new URL(layer.value).hostname)}</strong><p>${escapeHtml(layer.description || "")}</p><span>${escapeHtml(layer.value)}</span></div>`;
  }
  return shape(layer, placement);
}

function pageMarkup(job: PdfJob, page: PdfPage, index: number): string {
  const metrics = pageMetrics(page);
  const selected = new Set(page.layerIds);
  const assets = new Map(job.assets.map((asset, assetIndex) => [asset.id, { key: `pdf-asset-${assetIndex}`, width: asset.width, height: asset.height }]));
  const placement = { bounds: page.bounds, scale: metrics.scale };
  const contents: string[] = [];
  let bytes = 0;
  for (const item of job.layers) {
    if (!selected.has(item.id)) continue;
    const html = renderLayer(item, assets, placement);
    bytes += Buffer.byteLength(html);
    if (bytes > MAX_PDF_HTML_BYTES) throw new PdfJobError(413, "PDF_TOO_COMPLEX", "Страница PDF слишком сложная. Уменьшите область экспорта.");
    contents.push(html);
  }
  const [first, second] = PDF_FORMATS[page.format];
  const widthMm = page.orientation === "portrait" ? first : second;
  const heightMm = page.orientation === "portrait" ? second : first;
  return `<section class="page page-${index}" data-page="${index}" style="width:${metrics.width}px;height:${metrics.height}px;page:sheet${index}">
<header><span>${escapeHtml(page.name)}</span><small>${escapeHtml(job.title)} · Версия ${job.revision} · ${index + 1}/${job.pages.length}</small></header>
<div class="clip" data-clip style="left:${metrics.left}px;top:${metrics.top}px;width:${page.bounds.width * metrics.scale}px;height:${page.bounds.height * metrics.scale}px">
<div class="scene" style="width:${page.bounds.width * metrics.scale}px;height:${page.bounds.height * metrics.scale}px">${contents.join("")}</div></div>
</section><style>@page sheet${index}{size:${widthMm}mm ${heightMm}mm;margin:0}</style>`;
}

const STYLES = `
*{box-sizing:border-box}html,body{padding:0;margin:0;font-family:'Noto Sans',sans-serif;color:#111;background:#eceff3}
.page{position:relative;overflow:hidden;background:white;break-after:page;print-color-adjust:exact;-webkit-print-color-adjust:exact;margin:0 auto 16px}
.page:last-of-type{break-after:auto}header{position:absolute;left:45.35px;right:45.35px;top:28px;display:flex;justify-content:space-between;gap:12px;font-size:12px;white-space:nowrap;overflow:hidden}
header span{font-weight:700;overflow:hidden;text-overflow:ellipsis}header small{font-size:9px;color:#64748b;flex-shrink:0}.clip{position:absolute;overflow:hidden}.scene{position:absolute}.object{position:absolute}.vector{overflow:visible}.rich-text{line-height:1.4;overflow-wrap:anywhere;white-space:pre-wrap;text-align:center}
.rich-text p{margin:0;min-height:1.4em}.rich-text h1{font-size:1.75em;font-weight:700;margin:0 0 .3em}.rich-text h2{font-size:1.4em;font-weight:700;margin:0 0 .3em}.rich-text h3{font-size:1.15em;font-weight:700;margin:0 0 .3em}
.rich-text ul{list-style:disc;padding-left:1.4em;text-align:left;margin:0}.rich-text ol{list-style:decimal;padding-left:1.4em;text-align:left;margin:0}.rich-text li{margin:0}.rich-text code{font-family:'Noto Sans Mono',monospace;border-radius:3px;background:#0000000d;padding:.05em .2em}.rich-text pre{text-align:left;white-space:pre-wrap;border-radius:4px;padding:.5em;background:#0000000d}.rich-text pre code{padding:0;background:none}.rich-text .katex-display{margin:.3em 0}.link-card{border:1px solid #d4d4d4;overflow:hidden;background:white;overflow-wrap:anywhere}.link-card p{font-size:.85714em}.link-card span{font-size:.78571em;color:#334155}
@media print{html,body{background:#fff}.page{margin:0}}`;

export function renderPdfHtml(job: PdfJob, resourceCss: string, onlyPage?: number): string {
  const definitions = `<svg aria-hidden="true" style="position:absolute;width:0;height:0"><defs>${job.assets.map((asset, index) => `<image data-asset id="pdf-asset-${index}" width="${asset.width}" height="${asset.height}" href="data:image/webp;base64,${asset.data}"/>`).join("")}</defs></svg>`;
  const prefix = `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${PDF_CONTENT_POLICY}"><title>${escapeHtml(job.title)}</title><style>${resourceCss}\n${STYLES}</style></head><body>${definitions}`;
  const pages: string[] = [];
  let bytes = Buffer.byteLength(prefix);
  for (let index = 0; index < job.pages.length; index += 1) {
    if (onlyPage !== undefined && index !== onlyPage) continue;
    const html = pageMarkup(job, job.pages[index], index);
    bytes += Buffer.byteLength(html);
    if (bytes > MAX_PDF_HTML_BYTES) throw new PdfJobError(413, "PDF_TOO_COMPLEX", "PDF слишком сложный для одной выгрузки. Разделите экспорт.");
    pages.push(html);
  }
  return `${prefix}${pages.join("")}</body></html>`;
}
