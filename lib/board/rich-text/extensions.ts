import { Extensions } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import Mathematics from "@tiptap/extension-mathematics";
import { SAFE_KATEX_OPTIONS } from "./math";

export type MathClickHandler = (type: "inlineMath" | "blockMath", position: number, latex: string) => void;

export function createTextExtensions(onMathClick?: MathClickHandler): Extensions {
  return [
    StarterKit.configure({
      undoRedo: false, link: false, underline: false, strike: false,
      blockquote: false, horizontalRule: false, trailingNode: false,
      dropcursor: false, heading: { levels: [1, 2, 3] },
    }),
    Mathematics.configure({
      katexOptions: { ...SAFE_KATEX_OPTIONS },
      inlineOptions: { onClick: (node, position) => onMathClick?.("inlineMath", position, String(node.attrs.latex ?? "")) },
      blockOptions: { onClick: (node, position) => onMathClick?.("blockMath", position, String(node.attrs.latex ?? "")) },
    }),
  ];
}
