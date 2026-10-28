export type RichTextNodeType = "paragraph" | "heading" | "bulletList" | "orderedList" |
  "listItem" | "codeBlock" | "hardBreak" | "text" | "inlineMath" | "blockMath";
export type RichTextMarkType = "bold" | "italic" | "code";

export interface RichTextMark { type: RichTextMarkType }
export interface RichTextNode {
  type: RichTextNodeType;
  attrs?: Record<string, string | number | null>;
  content?: RichTextNode[];
  text?: string;
  marks?: RichTextMark[];
}
export interface RichTextDocument { type: "doc"; content: RichTextNode[] }

export const RICH_TEXT_SCHEMA_VERSION = 2;
export const MAX_RICH_TEXT_NODES = 5000;
export const MAX_RICH_TEXT_DEPTH = 12;
export const MAX_RICH_TEXT_LENGTH = 100_000;
export const MAX_LATEX_LENGTH = 2000;
export const MAX_MATH_NODES = 200;

export class RichTextValidationError extends Error {
  constructor(message: string) { super(message); this.name = "RichTextValidationError"; }
}
