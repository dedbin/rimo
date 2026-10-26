import { describe, expect, it } from "vitest";
import { BOARD_CLIPBOARD_MIME, isEditingTarget, offsetLayers, parseClipboardLayers, serializeLayers } from "@/lib/board/clipboard";
import { createLayer, MAX_CLIPBOARD_BYTES } from "@/lib/board/model";
import { LayerType } from "@/types/board-canvas";

describe("board clipboard", () => {
  it("round-trips versioned layers while preserving the relative layout", () => {
    const layers = [createLayer(LayerType.Rectangle, { x: 10, y: 20 }, { r: 0, g: 0, b: 0 }),
      createLayer(LayerType.Ellipse, { x: 40, y: 60 }, { r: 0, g: 0, b: 0 })];
    const decoded = parseClipboardLayers(serializeLayers(layers));
    expect(decoded).toEqual(layers);
    expect(offsetLayers(decoded!, 100, 200)).toMatchObject([{ x: 100, y: 200 }, { x: 130, y: 240 }]);
    expect(BOARD_CLIPBOARD_MIME).toContain("rimo");
  });

  it("rejects malformed, oversized or unsupported clipboard data", () => {
    expect(parseClipboardLayers("ordinary text")).toBeNull();
    expect(parseClipboardLayers("x".repeat(MAX_CLIPBOARD_BYTES + 1))).toBeNull();
    expect(parseClipboardLayers(JSON.stringify({ kind: "rimo-layers", version: 99, layers: [] }))).toBeNull();
    expect(parseClipboardLayers(JSON.stringify({ kind: "rimo-layers", version: 1, layers: [{ type: 42 }] }))).toBeNull();
  });

  it("preserves native clipboard handling for inputs and nested editable content", () => {
    const editor = document.createElement("div");
    editor.setAttribute("contenteditable", "true");
    const child = document.createElement("span");
    editor.append(child);
    expect(isEditingTarget(child)).toBe(true);
    expect(isEditingTarget(document.createElement("input"))).toBe(true);
    expect(isEditingTarget(document.createElement("textarea"))).toBe(true);
    expect(isEditingTarget(document.createElement("button"))).toBe(false);
  });
});
