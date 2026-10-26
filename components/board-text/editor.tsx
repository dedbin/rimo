"use client";

import { useEffect, useMemo, useRef } from "react";
import { Editor, EditorContent, useEditor } from "@tiptap/react";
import { toast } from "sonner";
import { useBoardRuntime, useConnectionState } from "@/lib/collaboration/react";
import { createTextExtensions } from "@/lib/board/rich-text/extensions";
import { createBoardTextBinding } from "@/lib/board/rich-text/yjs-binding";
import { plainTextDocument } from "@/lib/board/rich-text/validation";
import { useBoardText } from "./provider";

export function ActiveTextEditor({ id }: { id: string }) {
  const runtime = useBoardRuntime();
  const connection = useConnectionState();
  const { register, deactivate, openMath } = useBoardText();
  const editable = runtime.board.canEdit && connection.connected && connection.synced;
  const current = useRef<Editor | null>(null);
  const extensions = useMemo(() => [
    ...createTextExtensions(openMath),
    createBoardTextBinding({ fragment: runtime.board.getTextFragment(id), history: runtime.board,
      canEdit: () => runtime.board.canEdit, onInvalidContent: (message) => toast.error(message) }),
  ], [runtime, id, openMath]);
  const editor = useEditor({
    extensions, immediatelyRender: false, shouldRerenderOnTransaction: false,
    editable,
    editorProps: {
      attributes: { role: "textbox", "aria-label": "Текст на доске", spellcheck: "true", class: "outline-none" },
      handleKeyDown: (_view, event) => {
        if (event.key !== "Escape") return false;
        event.preventDefault(); event.stopPropagation(); deactivate(); return true;
      },
      handlePaste: (_view, event) => {
        event.preventDefault();
        try {
          const content = plainTextDocument(event.clipboardData?.getData("text/plain") ?? "");
          current.current?.commands.insertContent(content.content);
        } catch (error) { toast.error(error instanceof Error ? error.message : "Не удалось вставить текст"); }
        return true;
      },
    },
    onCreate: ({ editor: created }) => {
      current.current = created;
      register(id, created);
      requestAnimationFrame(() => { if (!created.isDestroyed) created.commands.focus("end", { scrollIntoView: false }); });
    },
    onDestroy: () => { current.current = null; register(id, null); },
  }, [id, runtime, extensions]);
  useEffect(() => { editor?.setEditable(editable); }, [editor, editable]);
  useEffect(() => () => { runtime.board.undoManager.stopCapturing(); }, [runtime]);
  return <EditorContent editor={editor} />;
}
