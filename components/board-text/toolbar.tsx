"use client";

import { useState } from "react";
import { useEditorState } from "@tiptap/react";
import { Bold, Italic, Code, CodeXml, List, ListOrdered, Sigma, SquareSigma, FileCode2, Pencil } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useBoardText } from "./provider";
import { MathDialog } from "./math-dialog";
import { MarkdownDialog } from "./markdown-dialog";

export function RichTextToolbar({ id }: { id: string }) {
  const { activeId, editor, activate, openMath } = useBoardText();
  const [markdownOpen, setMarkdownOpen] = useState(false);
  const active = useEditorState({ editor, selector: ({ editor: current }) => ({
    bold: current?.isActive("bold") ?? false, italic: current?.isActive("italic") ?? false,
    code: current?.isActive("code") ?? false, codeBlock: current?.isActive("codeBlock") ?? false,
    bulletList: current?.isActive("bulletList") ?? false, orderedList: current?.isActive("orderedList") ?? false,
    heading: current?.isActive("heading") ? String(current.getAttributes("heading").level) : "paragraph",
  }) });
  if (activeId !== id || !editor) return <Button variant="ghost" size="sm" onClick={() => activate(id)} aria-label="Редактировать текст">
    <Pencil className="mr-1 h-4 w-4" />Редактировать
  </Button>;
  const commands = [
    { label: "Жирный", Icon: Bold, pressed: active?.bold, run: () => editor.chain().focus().toggleBold().run() },
    { label: "Курсив", Icon: Italic, pressed: active?.italic, run: () => editor.chain().focus().toggleItalic().run() },
    { label: "Код в строке", Icon: Code, pressed: active?.code, run: () => editor.chain().focus().toggleCode().run() },
    { label: "Блок кода", Icon: CodeXml, pressed: active?.codeBlock, run: () => editor.chain().focus().toggleCodeBlock().run() },
    { label: "Маркированный список", Icon: List, pressed: active?.bulletList, run: () => editor.chain().focus().toggleBulletList().run() },
    { label: "Нумерованный список", Icon: ListOrdered, pressed: active?.orderedList, run: () => editor.chain().focus().toggleOrderedList().run() },
  ];
  return <div data-board-text-toolbar className="flex basis-full flex-wrap items-center gap-1 border-b border-neutral-200 pb-2">
    {commands.map(({ label, Icon, pressed, run }) => <Button key={label} size="icon" variant={pressed ? "secondary" : "ghost"}
      aria-label={label} title={label} aria-pressed={pressed} onMouseDown={(event) => event.preventDefault()} onClick={run}><Icon className="h-4 w-4" /></Button>)}
    <select aria-label="Стиль текста" value={active?.heading ?? "paragraph"} className="rounded border px-1 py-1 text-sm"
      onChange={(event) => {
        if (event.target.value === "paragraph") editor.chain().focus().setParagraph().run();
        else editor.chain().focus().toggleHeading({ level: Number(event.target.value) as 1 | 2 | 3 }).run();
      }}>
      <option value="paragraph">Обычный</option><option value="1">Заголовок 1</option><option value="2">Заголовок 2</option><option value="3">Заголовок 3</option>
    </select>
    <Button variant="ghost" size="icon" aria-label="Формула в строке" title="Формула в строке" onMouseDown={(event) => event.preventDefault()} onClick={() => openMath("inlineMath")}><Sigma className="h-4 w-4" /></Button>
    <Button variant="ghost" size="icon" aria-label="Формула отдельной строкой" title="Формула отдельной строкой" onMouseDown={(event) => event.preventDefault()} onClick={() => openMath("blockMath")}><SquareSigma className="h-4 w-4" /></Button>
    <Button variant="ghost" size="icon" aria-label="Импорт и экспорт Markdown" title="Markdown" onMouseDown={(event) => event.preventDefault()} onClick={() => setMarkdownOpen(true)}><FileCode2 className="h-4 w-4" /></Button>
    <MathDialog /><MarkdownDialog open={markdownOpen} onClose={() => setMarkdownOpen(false)} />
  </div>;
}
