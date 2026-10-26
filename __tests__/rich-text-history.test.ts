import { afterEach, describe, expect, it } from "vitest";
import { Editor } from "@tiptap/core";
import { ySyncPluginKey } from "@tiptap/y-tiptap";
import * as Y from "yjs";
import { createTextExtensions } from "@/lib/board/rich-text/extensions";
import { createBoardTextBinding } from "@/lib/board/rich-text/yjs-binding";
import { getRichTextJson, writeRichTextFragment } from "@/lib/board/rich-text/document";
import { plainTextDocument } from "@/lib/board/rich-text/validation";
import { BoardDocument } from "@/lib/collaboration/document";
import { createLayer } from "@/lib/board/model";
import { LayerType } from "@/types/board-canvas";

const editors: Editor[] = [];
const documents: Y.Doc[] = [];
const histories: Y.UndoManager[] = [];
afterEach(() => {
  editors.forEach((editor) => { if (!editor.isDestroyed) editor.destroy(); });
  histories.forEach((history) => history.destroy());
  documents.forEach((doc) => doc.destroy());
  editors.length = 0; documents.length = 0; histories.length = 0;
});

function setup(doc = new Y.Doc()) {
  documents.push(doc);
  const fragment = doc.getXmlFragment("text:layer");
  if (!fragment.length) writeRichTextFragment(fragment, plainTextDocument("Начало"));
  const undoManager = new Y.UndoManager(fragment, { trackedOrigins: new Set([ySyncPluginKey]), captureTimeout: 0,
    captureTransaction: (transaction) => transaction.meta.get("addToHistory") !== false });
  histories.push(undoManager);
  const history = { undoManager, undo: () => { undoManager.undo(); }, redo: () => { undoManager.redo(); } };
  const mount = (canEdit = () => true) => {
    const editor = new Editor({ element: document.createElement("div"),
      extensions: [...createTextExtensions(), createBoardTextBinding({ fragment, history, canEdit })] });
    editors.push(editor);
    return editor;
  };
  return { doc, fragment, history, mount };
}

describe("document-owned text undo", () => {
  it("orders text and geometry in one history while ignoring automatic height updates", () => {
    const board = new BoardDocument();
    const [textId, shapeId] = board.insert([
      createLayer(LayerType.Text, { x: 0, y: 0 }, { r: 0, g: 0, b: 0 }),
      createLayer(LayerType.Rectangle, { x: 100, y: 100 }, { r: 0, g: 0, b: 0 }),
    ]);
    const editor = new Editor({ element: document.createElement("div"), extensions: [
      ...createTextExtensions(), createBoardTextBinding({ fragment: board.getTextFragment(textId), history: board, canEdit: () => board.canEdit }),
    ] });
    editors.push(editor);
    try {
      editor.commands.insertContent({ type: "text", text: "A" });
      board.translate([shapeId], { x: 50, y: 50 });
      editor.commands.insertContent({ type: "text", text: "B" });
      board.setMeasuredTextHeight(textId, 64);
      editor.destroy();
      board.undo();
      expect(JSON.stringify(board.getRichText(textId))).toContain("A");
      expect(JSON.stringify(board.getRichText(textId))).not.toContain("B");
      expect(board.getLayer(shapeId)).toMatchObject({ x: 150, y: 150 });
      expect(board.getLayer(textId)).toMatchObject({ height: 64 });
      board.undo();
      expect(board.getLayer(shapeId)).toMatchObject({ x: 100, y: 100 });
      expect(JSON.stringify(board.getRichText(textId))).toContain("A");
      board.undo();
      expect(board.getRichText(textId)).toEqual(plainTextDocument(""));
    } finally { board.destroy(); }
  });

  it("preserves undo after editor unmount and remount, including toolbar history actions", () => {
    const { doc, history, mount } = setup();
    const first = mount();
    first.commands.insertContent({ type: "text", text: "A" });
    expect(first.getText()).toContain("A");
    first.destroy();
    history.undo();
    expect(JSON.stringify(getRichTextJson(doc, "layer"))).not.toContain('"text":"A');
    history.redo();
    const second = mount();
    expect(second.getText()).toContain("A");
    second.commands.insertContent({ type: "text", text: "B" });
    second.destroy();
    history.undo();
    const third = mount();
    expect(third.getText()).toContain("A");
    expect(third.getText()).not.toContain("B");
  });

  it("undoes the local author without removing a concurrent peer edit", () => {
    const first = setup();
    const peerDoc = new Y.Doc();
    Y.applyUpdate(peerDoc, Y.encodeStateAsUpdate(first.doc), "remote");
    const peer = setup(peerDoc);
    const firstEditor = first.mount();
    const peerEditor = peer.mount();
    firstEditor.commands.insertContent({ type: "text", text: "A" });
    peerEditor.commands.insertContent({ type: "text", text: "B" });
    Y.applyUpdate(first.doc, Y.encodeStateAsUpdate(peer.doc), "remote");
    Y.applyUpdate(peer.doc, Y.encodeStateAsUpdate(first.doc), "remote");
    firstEditor.destroy();
    first.history.undo();
    const text = JSON.stringify(getRichTextJson(first.doc, "layer"));
    expect(text).toContain("B");
    expect(text).not.toContain("A");
  });

  it("rejects local writes when access changes while the editor remains mounted", () => {
    const { doc, mount } = setup();
    let writable = true;
    const editor = mount(() => writable);
    const initial = Y.encodeStateAsUpdate(doc);
    writable = false;
    editor.commands.insertContent({ type: "text", text: "ЗАПРЕЩЕНО" });
    expect(Y.encodeStateAsUpdate(doc)).toEqual(initial);
  });
});
