import katex, { KatexOptions } from "katex";
import { MAX_LATEX_LENGTH, RichTextValidationError } from "./types";

export const SAFE_KATEX_OPTIONS: Readonly<KatexOptions> = Object.freeze({
  trust: false, throwOnError: false, maxExpand: 100, maxSize: 20,
  strict: "ignore", output: "htmlAndMathml",
});

export function renderSafeMath(latex: string, displayMode: boolean): string {
  if (latex.length > MAX_LATEX_LENGTH) throw new RichTextValidationError("Формула слишком длинная");
  return katex.renderToString(latex, { ...SAFE_KATEX_OPTIONS, displayMode });
}
