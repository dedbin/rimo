import assert from "node:assert/strict";
import { createRequire } from "node:module";

import { Document } from "@hocuspocus/server";
import * as Y from "yjs";

// Test-only IPC delivers SIGTERM on Windows without changing the production entry.
process.on("message", (message) => {
  if (message?.type === "probe") {
    assert.equal(Object.getPrototypeOf(Document.prototype), Y.Doc.prototype);
    const loaded = Object.keys(createRequire(import.meta.url).cache);
    process.send?.({ type: "native-runtime", nativeYjs: true,
      cjsYjsLoaded: loaded.some(filename => /[\\/]yjs[\\/]dist[\\/]yjs\.cjs$/.test(filename)),
      tsxLoaded: loaded.some(filename => /[\\/]tsx[\\/]/.test(filename)) });
  }
  if (message?.type === "stop") {
    process.emit("SIGTERM");
    process.disconnect();
  }
});
