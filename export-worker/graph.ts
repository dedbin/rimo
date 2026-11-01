import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { GraphPlot } from "../lib/board/graph/plot";
import type { GraphLayer } from "../types/board-canvas";
import { escapeHtml } from "./rich-text";

interface GraphPlacement {
  readonly id: string;
  readonly identifierPrefix: string;
  readonly position: string;
  readonly scale: number;
}

export function renderPdfGraph(layer: GraphLayer, placement: GraphPlacement): string {
  // Match the board's bounded logical canvas, then scale vectors to the paper rectangle.
  const width = Math.max(160, Math.min(960, layer.width));
  const height = Math.max(120, Math.min(720, layer.height));
  const scaleX = layer.width * placement.scale / width;
  const scaleY = layer.height * placement.scale / height;
  const markup = renderToStaticMarkup(createElement(GraphPlot, { graph: layer.graph, width, height }), {
    identifierPrefix: placement.identifierPrefix,
  });
  return `<div class="object graph-object" data-graph-id="${escapeHtml(placement.id)}" style="${placement.position}overflow:hidden"><div style="width:${width}px;height:${height}px;transform:scale(${scaleX},${scaleY});transform-origin:0 0">${markup}</div></div>`;
}
