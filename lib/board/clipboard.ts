import { Layer } from "@/types/board-canvas";
import { MAX_CLIPBOARD_BYTES, MAX_LAYERS, parseLayer } from "./model";
import { getBounds } from "./geometry";
import { RichTextDocument } from "./rich-text/types";
import { validateRichTextDocument } from "./rich-text/validation";

export const BOARD_CLIPBOARD_MIME = "application/x-rimo-layers+json";

export function serializeLayers(layers: readonly Layer[], richText?: readonly (RichTextDocument | null)[]): string {
  return JSON.stringify({ kind: "rimo-layers", version: richText ? 2 : 1, layers, ...(richText ? { richText } : {}) });
}

export interface BoardClipboard { layers: Layer[]; richText: (RichTextDocument | null)[] }

export function parseBoardClipboard(text: string): BoardClipboard | null {
  if (text.length > MAX_CLIPBOARD_BYTES) return null;
  try {
    const value: unknown = JSON.parse(text);
    if (typeof value !== "object" || value === null || !("kind" in value) || value.kind !== "rimo-layers" ||
      !("version" in value) || (value.version !== 1 && value.version !== 2) || !("layers" in value) || !Array.isArray(value.layers) ||
      value.layers.length === 0 || value.layers.length > MAX_LAYERS) return null;
    const layers = value.layers.map(parseLayer);
    if (!layers.every((layer): layer is Layer => layer !== null)) return null;
    if (value.version === 1) return { layers, richText: [] };
    if (!("richText" in value) || !Array.isArray(value.richText) || value.richText.length !== layers.length) return null;
    const richText = value.richText.map((document: unknown) => document === null ? null : validateRichTextDocument(document));
    return { layers, richText };
  } catch { return null; }
}

export function parseClipboardLayers(text: string): Layer[] | null { return parseBoardClipboard(text)?.layers ?? null; }

export function offsetLayers(layers: readonly Layer[], x: number, y: number): Layer[] {
  const bounds = getBounds(layers);
  if (!bounds) return [];
  return layers.map((layer) => ({ ...layer, x: layer.x - bounds.x + x, y: layer.y - bounds.y + y }));
}

export function isEditingTarget(target: EventTarget | null): boolean {
  return target instanceof Element && Boolean(target.closest(
    'input,textarea,select,[contenteditable="true"],[contenteditable="plaintext-only"],[role="textbox"]',
  ));
}
