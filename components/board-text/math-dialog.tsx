"use client";

import { useEffect, useState } from "react";
import { relativePositionToAbsolutePosition, SyncPluginState, ySyncPluginKey } from "@tiptap/y-tiptap";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { MAX_LATEX_LENGTH } from "@/lib/board/rich-text/types";
import { MathFormula } from "@/lib/board/rich-text/renderer";
import { useBoardText } from "./provider";

export function MathDialog() {
  const { editor, math, closeMath } = useBoardText();
  const [source, setSource] = useState("");
  const [error, setError] = useState("");
  useEffect(() => { setSource(math?.latex ?? ""); setError(""); }, [math]);
  const save = () => {
    if (!editor || !math) return;
    if (!source.trim() || source.length > MAX_LATEX_LENGTH) {
      setError(`Введите формулу длиной до ${MAX_LATEX_LENGTH} символов`);
      return;
    }
    const sync = ySyncPluginKey.getState(editor.state) as SyncPluginState | undefined;
    if (math.anchor) {
      const position = sync ? relativePositionToAbsolutePosition(sync.doc, sync.type, math.anchor, sync.binding.mapping) : null;
      const node = position === null ? null : editor.state.doc.nodeAt(position);
      if (position === null || node?.type.name !== math.type || node.attrs.latex !== math.latex) {
        setError("Формула была изменена другим участником. Скопируйте исходник и откройте её заново.");
        return;
      }
      editor.chain().setNodeSelection(position).updateAttributes(math.type, { latex: source }).run();
    } else if (math.type === "inlineMath") editor.commands.insertInlineMath({ latex: source });
    else editor.commands.insertBlockMath({ latex: source });
    closeMath();
  };
  return <Dialog open={math !== null} onOpenChange={(open) => { if (!open) closeMath(); }}>
    <DialogContent data-board-text-dialog onCloseAutoFocus={(event) => { event.preventDefault(); editor?.commands.focus(undefined, { scrollIntoView: false }); }}>
      <DialogTitle>{math?.anchor ? "Редактировать формулу" : "Добавить формулу"}</DialogTitle>
      <DialogDescription>Математическое выражение в LaTeX. Ошибочный исходник можно сохранить и исправить позже.</DialogDescription>
      <textarea aria-label="Исходник формулы LaTeX" value={source} onChange={(event) => setSource(event.target.value)}
        maxLength={MAX_LATEX_LENGTH} rows={4} className="w-full rounded-md border p-2 font-mono text-sm" />
      <div aria-label="Предпросмотр формулы" className="min-h-12 overflow-x-auto rounded-md border bg-neutral-50 p-3">
        <MathFormula latex={source} display={math?.type === "blockMath"} />
      </div>
      {error && <p role="alert" className="text-sm text-red-600">{error}</p>}
      <DialogFooter><Button variant="outline" onClick={closeMath}>Отмена</Button><Button onClick={save}>Сохранить формулу</Button></DialogFooter>
    </DialogContent>
  </Dialog>;
}
