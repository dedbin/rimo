import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import * as math from "@/lib/board/rich-text/math";
import { renderRichText } from "@/lib/board/rich-text/renderer";
import type { RichTextDocument } from "@/lib/board/rich-text/types";

function documentCopy(text = "Формула: ", inlineLatex = "x^2", blockLatex = "\\frac{1}{2}"): RichTextDocument {
  return { type: "doc", content: [
    { type: "paragraph", content: [
      { type: "text", text, marks: [{ type: "bold" }] },
      { type: "inlineMath", attrs: { latex: inlineLatex } },
    ] },
    { type: "blockMath", attrs: { latex: blockLatex } },
  ] };
}

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("rich-text renderer stability", () => {
  it("keeps paragraph, mark and math DOM for separate identical JSON copies", () => {
    const renderMath = vi.spyOn(math, "renderSafeMath");
    const first = documentCopy();
    const second = documentCopy();
    expect(second).toEqual(first);
    expect(second).not.toBe(first);
    expect(second.content[0]).not.toBe(first.content[0]);

    const view = render(<>{renderRichText(first)}</>);
    const paragraph = view.container.querySelector("p");
    const mark = paragraph?.querySelector("strong");
    const formulaNodes = [...view.container.querySelectorAll("[data-math-source]")];
    const katexNodes = [...view.container.querySelectorAll(".katex")];
    expect(paragraph).not.toBeNull();
    expect(mark).not.toBeNull();
    expect(formulaNodes).toHaveLength(2);
    expect(katexNodes).toHaveLength(2);
    expect(renderMath).toHaveBeenCalledTimes(2);

    view.rerender(<>{renderRichText(second)}</>);

    expect(view.container.querySelector("p")).toBe(paragraph);
    expect(view.container.querySelector("strong")).toBe(mark);
    const nextFormulas = [...view.container.querySelectorAll("[data-math-source]")];
    const nextKatex = [...view.container.querySelectorAll(".katex")];
    expect(nextFormulas).toHaveLength(formulaNodes.length);
    expect(nextKatex).toHaveLength(katexNodes.length);
    formulaNodes.forEach((node, index) => { expect(nextFormulas[index]).toBe(node); });
    katexNodes.forEach((node, index) => { expect(nextKatex[index]).toBe(node); });
    expect(renderMath).toHaveBeenCalledTimes(2);
  });

  it("still updates text and inline/block LaTeX when document values change", () => {
    const renderMath = vi.spyOn(math, "renderSafeMath");
    const view = render(<>{renderRichText(documentCopy())}</>);
    const previousHtml = [...view.container.querySelectorAll("[data-math-source]")].map((node) => node.innerHTML);

    view.rerender(<>{renderRichText(documentCopy("Новый текст: ", "y^3", "\\sqrt{z}"))}</>);

    expect(view.container.querySelector("strong")?.textContent).toBe("Новый текст: ");
    const formulaNodes = [...view.container.querySelectorAll("[data-math-source]")];
    expect(formulaNodes).toHaveLength(2);
    formulaNodes.forEach((node, index) => {
      expect(node.getAttribute("data-math-source")).toBe(["y^3", "\\sqrt{z}"][index]);
      expect(node.querySelector(".katex")).not.toBeNull();
      expect(node.querySelector('annotation[encoding="application/x-tex"]')?.textContent).toBe(["y^3", "\\sqrt{z}"][index]);
      expect(node.innerHTML).not.toBe(previousHtml[index]);
    });
    expect(renderMath).toHaveBeenCalledTimes(4);
  });
});
