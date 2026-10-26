import { Extension } from "@tiptap/core";
import { isChangeOrigin } from "@tiptap/extension-collaboration";
import { Plugin } from "@tiptap/pm/state";
import { ySyncPlugin } from "@tiptap/y-tiptap";
import * as Y from "yjs";
import { validateRichTextDocument } from "./validation";

interface Options {
  fragment: Y.XmlFragment;
  history: { undo: () => void; redo: () => void; undoManager: Y.UndoManager };
  canEdit: () => boolean;
  onInvalidContent?: (message: string) => void;
}

export function createBoardTextBinding({ fragment, history, canEdit, onInvalidContent }: Options): Extension {
  return Extension.create({
    name: "boardCollaboration", priority: 1000,
    addProseMirrorPlugins() {
      return [
        new Plugin({ filterTransaction(transaction) {
          if (!transaction.docChanged || isChangeOrigin(transaction)) return true;
          if (!canEdit()) return false;
          try { validateRichTextDocument(transaction.doc.toJSON()); }
          catch (error) {
            onInvalidContent?.(error instanceof Error ? error.message : "Некорректный текст");
            return false;
          }
          if (transaction.getMeta("inputRule")) history.undoManager.stopCapturing();
          return true;
        } }),
        // yUndoPlugin in pinned y-tiptap destroys even an externally supplied manager
        // when its view unmounts. Keep board history owned by BoardDocument instead.
        ySyncPlugin(fragment),
      ];
    },
    addKeyboardShortcuts() {
      return {
        "Mod-z": () => { if (canEdit()) history.undo(); return true; },
        "Mod-y": () => { if (canEdit()) history.redo(); return true; },
        "Mod-Shift-z": () => { if (canEdit()) history.redo(); return true; },
      };
    },
  });
}
