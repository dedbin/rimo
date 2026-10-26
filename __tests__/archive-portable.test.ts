// @vitest-environment node
import * as Y from "yjs";
import { describe, expect, it } from "vitest";

import { getRichTextJson, writeRichTextFragment } from "../lib/board/rich-text/document";
import { portableBoard } from "../server/archive/portable";
import { LayerType } from "../types/board-canvas";

describe("portable archive text representations", () => {
  it("retains the version 1 plain-text representation for existing archives", () => {
    const document = new Y.Doc();
    try {
      document.getMap("meta").set("schemaVersion", 1);
      const result = JSON.parse(portableBoard(document).toString("utf8"));
      expect(result).toEqual({ format: "rimo-portable-board", version: 1, schemaVersion: 1, layerIds: [], layers: {} });
    } finally { document.destroy(); }
  });

  it("exports typed rich text and LaTeX while the native state retains orphan fragments", () => {
    const document = new Y.Doc();
    try {
      document.getMap("meta").set("schemaVersion", 2);
      document.getMap("layers").set("text1", new Y.Map<unknown>([
        ["type", LayerType.Text], ["x", 0], ["y", 0], ["width", 300], ["height", 100],
        ["fill", { r: 0, g: 0, b: 0 }], ["fontSize", 16],
      ]));
      document.getArray("layerIds").push(["text1"]);
      writeRichTextFragment(document.getXmlFragment("text:text1"), { type: "doc", content: [{ type: "paragraph", content: [
        { type: "text", text: "Русский текст ", marks: [{ type: "bold" }] },
        { type: "inlineMath", attrs: { latex: "x^2 + y^2" } },
      ] }] });
      writeRichTextFragment(document.getXmlFragment("text:deleted"), { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Для undo" }] }] });
      const result = JSON.parse(portableBoard(document).toString("utf8"));
      expect(result.version).toBe(2);
      expect(result.richText).toEqual({ text1: getRichTextJson(document, "text1") });
      const copy = new Y.Doc();
      try {
        Y.applyUpdate(copy, Y.encodeStateAsUpdate(document));
        expect(getRichTextJson(copy, "deleted")).toEqual(getRichTextJson(document, "deleted"));
      } finally { copy.destroy(); }
    } finally { document.destroy(); }
  });
});
