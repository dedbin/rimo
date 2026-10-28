// @vitest-environment node
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import * as Y from "yjs";
import { getRichTextJson, migrateBoardDocument, textFragmentName, writeRichTextFragment } from "@/lib/board/rich-text/document";
import { parseRichTextMarkdown, serializeRichTextMarkdown } from "@/lib/board/rich-text/markdown";
import { plainTextDocument, validateRichTextDocument } from "@/lib/board/rich-text/validation";
import { MAX_LATEX_LENGTH, RichTextDocument } from "@/lib/board/rich-text/types";
import { renderRichText } from "@/lib/board/rich-text/renderer";
import { LayerType } from "@/types/board-canvas";

const sample: RichTextDocument = { type: "doc", content: [
  { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Русская математика" }] },
  { type: "paragraph", content: [
    { type: "text", text: "Формула: ", marks: [{ type: "bold" }] },
    { type: "inlineMath", attrs: { latex: "x^2 + y^2 = 1" } },
  ] },
  { type: "blockMath", attrs: { latex: "\\frac{1}{2}" } },
  { type: "orderedList", attrs: { start: 3 }, content: [
    { type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "Пункт", marks: [{ type: "italic" }] }] }] },
  ] },
  { type: "codeBlock", attrs: { language: "python" }, content: [{ type: "text", text: "x = 1" }] },
] };

describe("rich-text data and portable representation", () => {
  it("round-trips marks, typed attributes, Russian text and LaTeX through binary Yjs without a DOM", () => {
    const original = new Y.Doc();
    writeRichTextFragment(original.getXmlFragment(textFragmentName("layer")), sample);
    const restored = new Y.Doc();
    Y.applyUpdate(restored, Y.encodeStateAsUpdate(original));
    expect(getRichTextJson(restored, "layer")).toEqual(validateRichTextDocument(sample));
    original.destroy(); restored.destroy();
  });

  it("migrates v1 plain strings literally, without interpreting HTML", () => {
    const doc = new Y.Doc();
    doc.getMap("meta").set("schemaVersion", 1);
    doc.getMap("layers").set("text", new Y.Map<unknown>([
      ["type", LayerType.Text], ["value", '<img src=x onerror="alert(1)">\nВторая строка'],
    ]));
    expect(migrateBoardDocument(doc)).toBe(true);
    expect(doc.getMap("meta").get("schemaVersion")).toBe(2);
    expect(doc.getMap<Y.Map<unknown>>("layers").get("text")!.has("value")).toBe(false);
    expect(getRichTextJson(doc, "text")).toEqual(plainTextDocument('<img src=x onerror="alert(1)">\nВторая строка'));
    expect(migrateBoardDocument(doc)).toBe(false);
    doc.destroy();
  });

  it("rejects unknown nodes, attributes and marks rather than dropping them", () => {
    for (const node of [
      { type: "image", attrs: { src: "/api/assets/file" } },
      { type: "paragraph", attrs: { style: "color:red" } },
      { type: "paragraph", content: [{ type: "text", text: "link", marks: [{ type: "link", attrs: { href: "javascript:alert(1)" } }] }] },
      { type: "inlineMath", attrs: { latex: "a", onclick: "alert(1)" } },
    ]) expect(() => validateRichTextDocument({ type: "doc", content: [node] })).toThrow();
  });

  it("bounds formula input but keeps invalid LaTeX editable", () => {
    expect(() => validateRichTextDocument({ type: "doc", content: [
      { type: "blockMath", attrs: { latex: "a".repeat(MAX_LATEX_LENGTH + 1) } },
    ] })).toThrow(/Формула/);
    expect(validateRichTextDocument({ type: "doc", content: [
      { type: "blockMath", attrs: { latex: "\\frac{" } },
    ] }).content[0].attrs?.latex).toBe("\\frac{");
  });

  it("renders escaped plain text and untrusted math without executable links or images", () => {
    const source = validateRichTextDocument({ type: "doc", content: [
      ...plainTextDocument('<img src=x onerror="alert(1)">').content,
      { type: "blockMath", attrs: { latex: "\\href{javascript:alert(1)}{click}" } },
      { type: "blockMath", attrs: { latex: "\\includegraphics{https://example.invalid/a.png}" } },
    ] });
    const html = renderToStaticMarkup(<>{renderRichText(source)}</>);
    expect(html).toContain("&lt;img");
    expect(html).not.toContain("<img");
    expect(html).not.toContain("href=");
    expect(html).not.toContain("<script");
  });
});

describe("explicit Markdown subset", () => {
  it("imports and exports the supported formatting, lists, code and formulas", () => {
    const markdown = "## Задача\n\n**Жирный** и *курсив*, `код`, $x^2$.\n\n1. Один\n2. Два\n\n```python\nx = 1\n```\n\n$$\n\\frac{1}{2}\n$$";
    const parsed = parseRichTextMarkdown(markdown);
    const exported = serializeRichTextMarkdown(parsed);
    expect(exported).toContain("Задача");
    expect(exported).toContain("$x^2$");
    expect(parseRichTextMarkdown(exported)).toEqual(parsed);
  });

  it("explicitly rejects raw HTML, links, tables, task lists and unknown blocks", () => {
    for (const markdown of ["<b>HTML</b>", "[ссылка](https://example.org)", "| a | b |\n|---|---|\n|1|2|", "- [x] Готово", "> Цитата", "#### Четвёртый уровень"]) {
      expect(() => parseRichTextMarkdown(markdown)).toThrow();
    }
  });
});
