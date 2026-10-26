// @vitest-environment node
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { createLayer, parseLayer } from "@/lib/board/model";
import { validateRichTextDocument } from "@/lib/board/rich-text/validation";
import { LayerType } from "@/types/board-canvas";

describe("board input prototype boundaries", () => {
  it("rejects inherited layer fields produced by a malicious Y.Map __proto__ entry", () => {
    const doc = new Y.Doc();
    const inherited = createLayer(LayerType.Text, { x: 0, y: 0 }, { r: 0, g: 0, b: 0 });
    const layer = new Y.Map<unknown>([["__proto__", inherited]]);
    doc.getMap("layers").set("malicious", layer);
    const decoded: unknown = layer.toJSON();
    expect(Object.hasOwn(decoded as object, "type")).toBe(false);
    expect(parseLayer(decoded)).toBeNull();
    doc.destroy();
  });

  it("rejects inherited color fields and rich-text attributes", () => {
    const rectangle = createLayer(LayerType.Rectangle, { x: 0, y: 0 }, { r: 0, g: 0, b: 0 });
    expect(parseLayer({ ...rectangle, fill: Object.create({ r: 255, g: 0, b: 0 }) })).toBeNull();
    expect(() => validateRichTextDocument({ type: "doc", content: [
      { type: "blockMath", attrs: Object.create({ latex: "x^2" }) },
    ] })).toThrow();
  });
});
