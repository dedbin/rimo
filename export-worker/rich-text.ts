import { renderSafeMath } from "../lib/board/rich-text/math";
import type { RichTextDocument, RichTextNode } from "../lib/board/rich-text/types";

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!);
}

function renderNode(node: RichTextNode): string {
  const content = (node.content ?? []).map(renderNode).join("");
  switch (node.type) {
    case "text": {
      return (node.marks ?? []).reduce((text, mark) => {
        const tag = mark.type === "bold" ? "strong" : mark.type === "italic" ? "em" : "code";
        return `<${tag}>${text}</${tag}>`;
      }, escapeHtml(node.text ?? ""));
    }
    case "paragraph": return `<p>${content || "<br>"}</p>`;
    case "heading": {
      const level = node.attrs?.level === 1 ? 1 : node.attrs?.level === 2 ? 2 : 3;
      return `<h${level}>${content}</h${level}>`;
    }
    case "bulletList": return `<ul>${content}</ul>`;
    case "orderedList": return `<ol start="${Number(node.attrs?.start ?? 1)}">${content}</ol>`;
    case "listItem": return `<li>${content}</li>`;
    case "codeBlock": return `<pre><code>${content}</code></pre>`;
    case "hardBreak": return "<br>";
    case "inlineMath": return renderSafeMath(String(node.attrs?.latex ?? ""), false);
    case "blockMath": return `<div>${renderSafeMath(String(node.attrs?.latex ?? ""), true)}</div>`;
  }
}

export function renderPdfRichText(document: RichTextDocument): string {
  return document.content.map(renderNode).join("");
}
