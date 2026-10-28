import { memo, ReactNode } from "react";
import { renderJSONContentToReactElement, type TiptapStaticRendererOptions } from "@tiptap/static-renderer/json/react";
import { RichTextDocument, RichTextMark, RichTextNode } from "./types";
import { validateRichTextDocument } from "./validation";
import { renderSafeMath } from "./math";

type RenderNode = RichTextNode | RichTextDocument;

export const MathFormula = memo(({ latex, display = false }: { latex: string; display?: boolean }) => {
  try {
    // Only KaTeX-generated markup is inserted. User text and errors remain React text.
    const html = renderSafeMath(latex, display);
    return <span data-math-source={latex} className={display ? "block overflow-x-auto" : "inline"}
      dangerouslySetInnerHTML={{ __html: html }} />;
  } catch {
    return <code className="text-red-700">{latex}</code>;
  }
});
MathFormula.displayName = "MathFormula";

const RENDER_OPTIONS: TiptapStaticRendererOptions<ReactNode, RichTextMark, RenderNode> = {
  nodeMapping: {
    doc: ({ children }) => <>{children}</>,
    text: ({ node }) => "text" in node ? node.text : "",
    paragraph: ({ children }) => <p>{children || <br />}</p>,
    heading: ({ node, children }) => {
      const level = "attrs" in node ? node.attrs?.level : 1;
      return level === 1 ? <h1>{children}</h1> : level === 2 ? <h2>{children}</h2> : <h3>{children}</h3>;
    },
    bulletList: ({ children }) => <ul>{children}</ul>,
    orderedList: ({ node, children }) => <ol start={"attrs" in node ? Number(node.attrs?.start ?? 1) : 1}>{children}</ol>,
    listItem: ({ children }) => <li>{children}</li>,
    codeBlock: ({ children }) => <pre><code>{children}</code></pre>,
    hardBreak: () => <br />,
    inlineMath: ({ node }) => <MathFormula latex={"attrs" in node ? String(node.attrs?.latex ?? "") : ""} />,
    blockMath: ({ node }) => <div><MathFormula display latex={"attrs" in node ? String(node.attrs?.latex ?? "") : ""} /></div>,
  },
  markMapping: {
    bold: ({ children }) => <strong>{children}</strong>,
    italic: ({ children }) => <em>{children}</em>,
    code: ({ children }) => <code>{children}</code>,
  },
};

export function renderRichText(input: RichTextDocument): ReactNode {
  // Reset generated keys per document while preserving mapping component identities.
  const render = renderJSONContentToReactElement<RichTextMark, RenderNode>(RENDER_OPTIONS);
  return render({ content: validateRichTextDocument(input) });
}
