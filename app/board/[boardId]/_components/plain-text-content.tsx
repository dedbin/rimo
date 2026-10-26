"use client";

import { ClipboardEvent, useEffect, useRef, useState } from "react";
import { useBoardRuntime } from "@/lib/collaboration/react";

interface Props {
  id: string;
  value: string;
  className?: string;
  style?: React.CSSProperties;
}

export function PlainTextContent({ id, value, className, style }: Props) {
  const runtime = useBoardRuntime();
  const element = useRef<HTMLDivElement>(null);
  const composing = useRef(false);
  const [editing, setEditing] = useState(false);
  useEffect(() => {
    if (element.current && !composing.current && element.current.textContent !== value) {
      element.current.textContent = value;
    }
  }, [value]);
  useEffect(() => {
    if (!editing) return;
    const outside = (event: globalThis.PointerEvent) => {
      if (!(event.target instanceof Node) || element.current?.contains(event.target)) return;
      element.current?.blur();
      setEditing(false);
    };
    // Canvas pointer gestures prevent the browser's default focus change.
    document.addEventListener("pointerdown", outside, true);
    return () => document.removeEventListener("pointerdown", outside, true);
  }, [editing]);
  const update = () => {
    if (element.current) runtime.board.update([id], { value: element.current.innerText ?? element.current.textContent ?? "" });
  };
  const paste = (event: ClipboardEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    const text = event.clipboardData.getData("text/plain");
    const selection = window.getSelection();
    if (!selection?.rangeCount || !element.current?.contains(selection.anchorNode)) return;
    const range = selection.getRangeAt(0);
    range.deleteContents();
    const node = document.createTextNode(text);
    range.insertNode(node);
    range.setStartAfter(node);
    range.collapse(true);
    selection.removeAllRanges();
    selection.addRange(range);
    update();
  };
  return <div ref={element} role={editing ? "textbox" : undefined} aria-label="Текст на доске"
    contentEditable={editing && runtime.board.canEdit} suppressContentEditableWarning spellCheck={editing}
    className={className} style={{ ...style, whiteSpace: "pre-wrap", overflowWrap: "anywhere", cursor: editing ? "text" : "inherit", userSelect: editing ? "text" : "none" }}
    data-placeholder="Текст" onDoubleClick={(event) => {
      if (!runtime.board.canEdit) return;
      event.stopPropagation();
      setEditing(true);
      requestAnimationFrame(() => {
        element.current?.focus();
        const selection = window.getSelection();
        const range = document.createRange();
        if (element.current) { range.selectNodeContents(element.current); range.collapse(false); selection?.removeAllRanges(); selection?.addRange(range); }
      });
    }}
    onPointerDown={(event) => { if (editing) event.stopPropagation(); }}
    onInput={update} onPaste={paste} onBlur={() => { update(); setEditing(false); }}
    onCompositionStart={() => { composing.current = true; }}
    onCompositionEnd={() => { composing.current = false; update(); }}
    onKeyDown={(event) => { if (event.key === "Escape") { event.stopPropagation(); element.current?.blur(); } }} />;
}
