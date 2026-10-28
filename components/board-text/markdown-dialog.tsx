"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { parseRichTextMarkdown, serializeRichTextMarkdown } from "@/lib/board/rich-text/markdown";
import { useBoardText } from "./provider";

export function MarkdownDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { editor } = useBoardText();
  const [source, setSource] = useState("");
  const [error, setError] = useState("");
  useEffect(() => {
    if (!open || !editor) return;
    try { setSource(serializeRichTextMarkdown(editor.getJSON())); setError(""); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Не удалось выгрузить Markdown"); }
  }, [open, editor]);
  const apply = () => {
    if (!editor) return;
    try {
      const content = parseRichTextMarkdown(source);
      editor.commands.setContent(content);
      onClose();
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Не удалось разобрать Markdown"); }
  };
  return <Dialog open={open} onOpenChange={(next) => { if (!next) onClose(); }}>
    <DialogContent data-board-text-dialog onCloseAutoFocus={(event) => { event.preventDefault(); editor?.commands.focus(undefined, { scrollIntoView: false }); }}>
      <DialogTitle>Markdown</DialogTitle>
      <DialogDescription>Абзацы, заголовки до третьего уровня, жирный и курсив, списки, код, $формулы$ и отдельные $$блоки$$. HTML, ссылки, изображения и таблицы не поддерживаются. Размер шрифта хранится в архиве Rimo.</DialogDescription>
      <textarea aria-label="Исходник Markdown" value={source} onChange={(event) => setSource(event.target.value)}
        rows={12} maxLength={100_000} className="w-full rounded-md border p-2 font-mono text-sm" />
      {error && <p role="alert" className="text-sm text-red-600">{error}</p>}
      <DialogFooter>
        <Button variant="outline" onClick={() => { void navigator.clipboard.writeText(source).then(() => toast.success("Markdown скопирован"), () => toast.error("Не удалось скопировать Markdown")); }}>Скопировать</Button>
        <Button onClick={apply}>Заменить текст</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>;
}
