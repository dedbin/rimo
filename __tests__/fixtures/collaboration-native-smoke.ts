import assert from "node:assert/strict";
import { createRequire } from "node:module";
import * as Y from "yjs";
import { Document as HocuspocusDocument } from "@hocuspocus/server";

import { createCollaborationDependencies } from "../../collaboration-server/dependencies";
import { initializeDocument, validateDocument } from "../../collaboration-server/document";
import { createCollaborationServer } from "../../collaboration-server/server";
import { DEFAULT_LIMITS } from "../../collaboration-server/types";
import { getRichTextJson, writeRichTextFragment } from "../../lib/board/rich-text/document";

assert.equal(typeof createCollaborationServer, "function");
assert.equal(typeof createCollaborationDependencies, "function");
assert.equal(Object.getPrototypeOf(HocuspocusDocument.prototype), Y.Doc.prototype);
const document = new HocuspocusDocument("native-import-smoke");
const peer = new Y.Doc();
try {
  assert(document instanceof Y.Doc);
  initializeDocument(document);
  const fragment = document.getXmlFragment("text:proof");
  const content = { type: "doc", content: [{ type: "paragraph", content: [
    { type: "text", text: "Формула ", marks: [{ type: "bold" }] },
    { type: "inlineMath", attrs: { latex: "x^2" } },
  ] }] };
  writeRichTextFragment(fragment, content);
  assert(fragment instanceof Y.XmlFragment);
  assert(fragment.get(0) instanceof Y.XmlElement);
  assert((fragment.get(0) as Y.XmlElement).get(0) instanceof Y.XmlText);
  assert.deepEqual(getRichTextJson(document, "proof"), content);
  const state = validateDocument(document, DEFAULT_LIMITS);
  Y.applyUpdate(peer, state);
  assert.deepEqual(getRichTextJson(peer, "proof"), content);
  assert.deepEqual(validateDocument(peer, DEFAULT_LIMITS), state);
  peer.getXmlFragment("text:forbidden").insert(0, [new Y.XmlElement("script")]);
  assert.throws(() => validateDocument(peer, DEFAULT_LIMITS), /Invalid rich text/);
  const require = createRequire(import.meta.url);
  const cjsYjsLoaded = Object.keys(require.cache).some(filename => /[\\/]yjs[\\/]dist[\\/]yjs\.cjs$/.test(filename));
  assert.equal(cjsYjsLoaded, false);
  assert.equal(Object.getOwnPropertyDescriptor(Y, "encodeStateAsUpdate")?.get, undefined);
  const network = (globalThis as typeof globalThis & { __compiledRuntimeNetwork: { connect: number; listen: number } }).__compiledRuntimeNetwork;
  assert.deepEqual(network, { connect: 0, listen: 0 });
  process.stdout.write(`${JSON.stringify({ nativeYjs: true, hocuspocusIdentity: true, xmlIdentity: true,
    richTextRoundtrip: true, strictXmlRejected: true, cjsYjsLoaded, network,
    tsxLoaded: Object.keys(require.cache).some(filename => /[\\/]tsx[\\/]/.test(filename)) })}\n`);
} finally { document.destroy(); peer.destroy(); }
