import {
  MAX_LATEX_LENGTH, MAX_MATH_NODES, MAX_RICH_TEXT_DEPTH, MAX_RICH_TEXT_LENGTH,
  MAX_RICH_TEXT_NODES, RichTextDocument, RichTextMark, RichTextNode,
  RichTextNodeType, RichTextValidationError,
} from "./types";

const blocks = new Set(["paragraph", "heading", "bulletList", "orderedList", "codeBlock", "blockMath"]);
const inlines = new Set(["text", "inlineMath", "hardBreak"]);
const allowedMarks = new Set(["bold", "italic", "code"]);
interface Budget { nodes: number; length: number; math: number }

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value) &&
  (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
function fail(message: string): never { throw new RichTextValidationError(message); }
function keys(input: Record<string, unknown>, allowed: readonly string[]): void {
  for (const key of Object.keys(input)) if (!allowed.includes(key)) fail(`Неподдерживаемое поле текста: ${key}`);
}

function parseMarks(value: unknown): RichTextMark[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > 3) fail("Некорректное форматирование текста");
  const seen = new Set<string>();
  return value.map((mark: unknown) => {
    if (!record(mark) || !Object.hasOwn(mark, "type") || typeof mark.type !== "string" || !allowedMarks.has(mark.type) || seen.has(mark.type)) {
      fail("Неподдерживаемое форматирование текста");
    }
    keys(mark, ["type", "attrs"]);
    if (mark.attrs !== undefined && (!record(mark.attrs) || Object.keys(mark.attrs).length > 0)) fail("Атрибуты форматирования не поддерживаются");
    seen.add(mark.type);
    return { type: mark.type as RichTextMark["type"] };
  });
}

function parseNode(value: unknown, depth: number, budget: Budget): RichTextNode {
  budget.nodes += 1;
  if (depth > MAX_RICH_TEXT_DEPTH || budget.nodes > MAX_RICH_TEXT_NODES) fail("Текст слишком сложный");
  if (!record(value) || !Object.hasOwn(value, "type") || typeof value.type !== "string") fail("Некорректный узел текста");
  keys(value, ["type", "attrs", "content", "text", "marks"]);
  const type = value.type as RichTextNodeType;
  if (!blocks.has(type) && !inlines.has(type) && type !== "listItem") fail(`Неподдерживаемый элемент: ${type}`);
  const node: RichTextNode = { type };
  const attrs = value.attrs === undefined ? {} : value.attrs;
  if (!record(attrs)) fail("Некорректные атрибуты текста");
  if (type === "text") {
    keys(attrs, []);
    if (typeof value.text !== "string" || value.text.length === 0 || value.content !== undefined) fail("Некорректная текстовая строка");
    budget.length += value.text.length;
    node.text = value.text;
  } else {
    if (value.text !== undefined) fail("Строка допустима только в текстовом узле");
    if (type === "heading") {
      keys(attrs, ["level"]);
      if (!Object.hasOwn(attrs, "level") || ![1, 2, 3].includes(attrs.level as number)) fail("Поддерживаются заголовки первого, второго и третьего уровня");
      node.attrs = { level: attrs.level as number };
    } else if (type === "orderedList") {
      keys(attrs, ["start", "type"]);
      const start = attrs.start ?? 1;
      if (!Number.isSafeInteger(start) || (start as number) < 1 || (start as number) > 1_000_000 || (attrs.type !== undefined && attrs.type !== null)) fail("Некорректная нумерация списка");
      node.attrs = { start: start as number };
    } else if (type === "codeBlock") {
      keys(attrs, ["language"]);
      const language = attrs.language ?? null;
      if (language !== null && (typeof language !== "string" || !/^[a-zA-Z0-9+#._-]{1,32}$/.test(language))) fail("Некорректное название языка кода");
      node.attrs = { language: language as string | null };
    } else if (type === "inlineMath" || type === "blockMath") {
      keys(attrs, ["latex"]);
      if (!Object.hasOwn(attrs, "latex") || typeof attrs.latex !== "string" || attrs.latex.length > MAX_LATEX_LENGTH) fail(`Формула должна содержать не больше ${MAX_LATEX_LENGTH} символов`);
      budget.math += 1;
      if (budget.math > MAX_MATH_NODES) fail("Слишком много формул в одном тексте");
      node.attrs = { latex: attrs.latex };
    } else keys(attrs, []);
  }
  if (budget.length > MAX_RICH_TEXT_LENGTH) fail("Текст слишком длинный");
  const marks = parseMarks(value.marks);
  if (marks?.length) {
    if (!inlines.has(type)) fail("Форматирование применимо к тексту внутри абзаца");
    node.marks = marks;
  }
  if (value.content !== undefined && !Array.isArray(value.content)) fail("Некорректное содержимое текста");
  const children = (value.content as unknown[] | undefined) ?? [];
  if (inlines.has(type) || type === "blockMath") {
    if (children.length) fail("Этот элемент не может содержать вложенные узлы");
  } else {
    node.content = children.map((child) => parseNode(child, depth + 1, budget));
    if (type === "paragraph" || type === "heading") {
      if (node.content.some((child) => !inlines.has(child.type))) fail("Абзац содержит неподдерживаемый элемент");
    } else if (type === "codeBlock") {
      if (node.content.some((child) => child.type !== "text" || child.marks?.length)) fail("Блок кода содержит форматирование");
    } else if (type === "bulletList" || type === "orderedList") {
      if (!node.content.length || node.content.some((child) => child.type !== "listItem")) fail("Некорректный список");
    } else if (type === "listItem") {
      if (node.content[0]?.type !== "paragraph" || node.content.some((child) => !blocks.has(child.type))) fail("Некорректный пункт списка");
    }
  }
  return node;
}

export function validateRichTextDocument(value: unknown): RichTextDocument {
  if (!record(value) || !Object.hasOwn(value, "type") || !Object.hasOwn(value, "content") || value.type !== "doc" || !Array.isArray(value.content)) fail("Некорректный текстовый документ");
  keys(value, ["type", "content"]);
  const budget: Budget = { nodes: 0, length: 0, math: 0 };
  const content = value.content.map((node) => parseNode(node, 1, budget));
  if (content.some((node) => !blocks.has(node.type))) fail("Документ должен состоять из абзацев и блоков");
  return { type: "doc", content: content.length ? content : [{ type: "paragraph", content: [] }] };
}

export function plainTextDocument(text: string): RichTextDocument {
  return validateRichTextDocument({ type: "doc", content: text.replace(/\r\n?/g, "\n").split("\n").map((line) => ({
    type: "paragraph", content: line ? [{ type: "text", text: line }] : [],
  })) });
}
