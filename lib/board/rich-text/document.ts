import * as Y from "yjs";
import { yXmlFragmentToProsemirrorJSON } from "@tiptap/y-tiptap";
import { LayerType } from "@/types/board-canvas";
import { MAX_RICH_TEXT_DEPTH, MAX_RICH_TEXT_LENGTH, MAX_RICH_TEXT_NODES, RICH_TEXT_SCHEMA_VERSION, RichTextDocument, RichTextNode, RichTextValidationError } from "./types";
import { plainTextDocument, validateRichTextDocument } from "./validation";

export function textFragmentName(id: string): string {
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(id)) throw new RichTextValidationError("Некорректный идентификатор текста");
  return `text:${id}`;
}

function checkXmlBudget(fragment: Y.XmlFragment): void {
  const pending: { node: unknown; depth: number }[] = fragment.toArray().map((node) => ({ node, depth: 1 }));
  let nodes = 0;
  let length = 0;
  while (pending.length) {
    const { node, depth } = pending.pop()!;
    nodes += 1;
    if (nodes > MAX_RICH_TEXT_NODES || depth > MAX_RICH_TEXT_DEPTH) throw new RichTextValidationError("Текст слишком сложный");
    if (node instanceof Y.XmlElement) {
      for (const child of node.toArray()) pending.push({ node: child, depth: depth + 1 });
    } else if (node instanceof Y.XmlText) {
      const delta = node.toDelta();
      nodes += Math.max(0, delta.length - 1);
      for (const part of delta) {
        if (typeof part.insert !== "string") throw new RichTextValidationError("Вложения внутри текста не поддерживаются");
        length += part.insert.length;
      }
      if (nodes > MAX_RICH_TEXT_NODES || length > MAX_RICH_TEXT_LENGTH) throw new RichTextValidationError("Текст слишком сложный или длинный");
    } else throw new RichTextValidationError("Некорректный тип содержимого текста");
  }
}

export function getRichTextJson(doc: Y.Doc, id: string): RichTextDocument {
  const name = textFragmentName(id);
  if (!doc.share.has(name)) return plainTextDocument("");
  const fragment = doc.getXmlFragment(name);
  checkXmlBudget(fragment);
  return validateRichTextDocument(yXmlFragmentToProsemirrorJSON(fragment));
}

function encodeNode(node: RichTextNode): Y.XmlElement | Y.XmlText {
  if (node.type === "text") {
    const text = new Y.XmlText();
    const attributes = Object.fromEntries((node.marks ?? []).map((mark) => [mark.type, {}]));
    text.insert(0, node.text ?? "", attributes);
    return text;
  }
  const element = new Y.XmlElement(node.type);
  for (const [key, value] of Object.entries(node.attrs ?? {})) {
    // ProseMirror's Yjs binding stores typed attribute values, including numbers and null.
    element.setAttribute(key, value as string);
  }
  const children = (node.content ?? []).map(encodeNode);
  if (children.length) element.insert(0, children);
  return element;
}

export function writeRichTextFragment(fragment: Y.XmlFragment, input: unknown): void {
  const content = validateRichTextDocument(input).content.map(encodeNode);
  if (fragment.length) fragment.delete(0, fragment.length);
  fragment.insert(0, content);
}

export function migrateBoardDocument(doc: Y.Doc): boolean {
  const meta = doc.getMap("meta");
  const version = meta.get("schemaVersion");
  if (version === RICH_TEXT_SCHEMA_VERSION) return false;
  if (version !== 1) throw new RichTextValidationError("Версия документа не поддерживается");
  const prepared: { layer: Y.Map<unknown>; fragment: Y.XmlFragment; content: RichTextDocument }[] = [];
  for (const [id, layer] of doc.getMap<Y.Map<unknown>>("layers")) {
    if (!(layer instanceof Y.Map)) throw new RichTextValidationError("Некорректный слой");
    if (layer.get("type") !== LayerType.Text && layer.get("type") !== LayerType.Sticker) continue;
    const value = layer.get("value");
    prepared.push({ layer, fragment: doc.getXmlFragment(textFragmentName(id)), content: plainTextDocument(typeof value === "string" ? value : "") });
  }
  doc.transact(() => {
    for (const { layer, fragment, content } of prepared) {
      if (fragment.length === 0) writeRichTextFragment(fragment, content);
      layer.delete("value");
    }
    meta.set("schemaVersion", RICH_TEXT_SCHEMA_VERSION);
  }, "schema-migration");
  return true;
}
