import { MarkdownManager } from "@tiptap/markdown";
import { Marked, marked } from "marked";
import { createTextExtensions } from "./extensions";
import { MAX_RICH_TEXT_LENGTH, MAX_RICH_TEXT_NODES, RichTextDocument, RichTextValidationError } from "./types";
import { validateRichTextDocument } from "./validation";

function createManager(): MarkdownManager {
  // The package types request the callable default export; its public implementation
  // uses the same lexer/configuration methods provided by an isolated Marked instance.
  return new MarkdownManager({ marked: new Marked() as unknown as typeof marked,
    markedOptions: { gfm: true, breaks: false }, extensions: createTextExtensions() });
}

function validateTokens(tokens: unknown[]): void {
  const allowed = new Set(["space", "paragraph", "heading", "list", "list_item", "text", "escape",
    "strong", "em", "codespan", "code", "br", "inlineMath", "blockMath"]);
  const pending = tokens.map((token) => ({ token, depth: 0 }));
  let count = 0;
  while (pending.length) {
    const { token, depth } = pending.pop()!;
    count += 1;
    if (depth > 12 || count > MAX_RICH_TEXT_NODES * 2) throw new RichTextValidationError("Markdown слишком сложный");
    if (typeof token !== "object" || token === null || !("type" in token) || typeof token.type !== "string") {
      throw new RichTextValidationError("Не удалось разобрать Markdown");
    }
    if (!allowed.has(token.type)) throw new RichTextValidationError(
      token.type === "html" ? "HTML в Markdown не поддерживается. Вставьте его как обычный текст."
        : `Элемент Markdown «${token.type}» пока не поддерживается. Исходный текст сохранён в поле ввода.`,
    );
    if (token.type === "heading" && "depth" in token && Number(token.depth) > 3) {
      throw new RichTextValidationError("Поддерживаются заголовки до третьего уровня");
    }
    if ("task" in token && token.task) throw new RichTextValidationError("Списки задач пока не поддерживаются");
    for (const key of ["tokens", "items"] as const) {
      const children = (token as Record<string, unknown>)[key];
      if (Array.isArray(children)) {
        for (const child of children) pending.push({ token: child, depth: depth + 1 });
      }
    }
  }
}

export function parseRichTextMarkdown(source: string): RichTextDocument {
  if (source.length > MAX_RICH_TEXT_LENGTH) throw new RichTextValidationError("Markdown слишком длинный");
  const manager = createManager();
  validateTokens(manager.instance.lexer(source));
  return validateRichTextDocument(manager.parse(source));
}

export function serializeRichTextMarkdown(input: unknown): string {
  return createManager().serialize(validateRichTextDocument(input));
}
