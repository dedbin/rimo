// @vitest-environment node
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import * as Y from "yjs";

import { Path } from "@/app/board/[boardId]/_components/path";
import { renderPdfHtml } from "@/export-worker/render";
import { parsePdfJob } from "@/export-worker/validation";
import { offsetLayers, parseClipboardLayers, serializeLayers } from "@/lib/board/clipboard";
import { rgbToCss } from "@/lib/board/colors";
import { BOARD_SCHEMA_VERSION } from "@/lib/board/model";
import { BoardDocument } from "@/lib/collaboration/document";
import { makePathLayer } from "@/lib/utils";
import { portableBoard } from "@/server/archive/portable";
import { validateArchiveFile } from "@/server/archive/validate";
import type { PathLayer } from "@/types/board-canvas";

import { nativeArchive } from "./archive-fixtures";

function marker(opacity?: number): PathLayer {
  return makePathLayer([[20, 30, 0.5], [80, 40, 0.5], [140, 30, 0.5]],
    { r: 234, g: 179, b: 8, ...(opacity === undefined ? {} : { a: opacity }) }, 24);
}

describe("marker opacity through saved and portable board data", () => {
  it("retains alpha through undo/redo, synchronization, reload and the saved SVG path", () => {
    const board = new BoardDocument();
    const reloaded = new BoardDocument();
    try {
      board.doc.getMap("meta").set("schemaVersion", BOARD_SCHEMA_VERSION);
      const layer = marker(0.25);
      const [id] = board.insert([layer]);
      board.undo();
      expect(board.getLayer(id)).toBeUndefined();
      board.redo();
      Y.applyUpdate(reloaded.doc, Y.encodeStateAsUpdate(board.doc), "remote");
      expect(reloaded.getLayer(id)).toEqual(layer);
      const saved = reloaded.getLayer(id) as PathLayer;
      const svg = renderToStaticMarkup(<svg><Path x={saved.x} y={saved.y} points={saved.points}
        fill={rgbToCss(saved.fill)} size={saved.size} /></svg>);
      expect(svg).toContain('fill="rgba(234,179,8,0.25)"');
    } finally { board.destroy(); reloaded.destroy(); }
  });

  it.each([0.25, 0.5, 1])("keeps opacity %s through a native archive, clipboard and vector PDF", async (opacity) => {
    const root = path.resolve("temp");
    const directory = await mkdtemp(path.join(root, "marker-opacity-"));
    const board = new BoardDocument();
    try {
      const layer = marker(opacity);
      const archive = await nativeArchive({ configure(document) {
        document.getMap("layers").set("marker", new Y.Map(Object.entries(layer)));
        document.getArray("layerIds").push(["marker"]);
      } });
      const filename = path.join(directory, "marker.rimo");
      await writeFile(filename, archive);
      const validated = await validateArchiveFile(filename, directory, new AbortController().signal);
      Y.applyUpdate(board.doc, validated.state);
      expect(board.getLayer("marker")).toEqual(layer);
      expect(JSON.parse(portableBoard(board.doc).toString("utf8")).layers.marker.fill.a).toBe(opacity);
      const decoded = parseClipboardLayers(serializeLayers([board.getLayer("marker")!]))!;
      expect(offsetLayers(decoded, 300, 200)[0]).toMatchObject({ fill: layer.fill });
      const job = parsePdfJob({ version: 1, title: "Полупрозрачный маркер", revision: 1,
        savedAt: "2026-11-01T12:00:00.000Z", layers: [{ id: "marker", layer: decoded[0] }], assets: [],
        pages: [{ name: "Урок", format: "A4", orientation: "portrait",
          bounds: { x: 0, y: 0, width: 200, height: 100 }, layerIds: ["marker"] }],
      });
      expect(renderPdfHtml(job, "")).toContain(`fill="rgba(234,179,8,${opacity})"`);
    } finally {
      board.destroy();
      if (path.dirname(directory) !== root) throw new Error("Unexpected marker test cleanup directory");
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("keeps legacy strokes without an alpha channel opaque", () => {
    const layer = marker();
    const [decoded] = parseClipboardLayers(serializeLayers([layer]))!;
    expect(decoded).toEqual(layer);
    expect("a" in layer.fill).toBe(false);
    expect(rgbToCss(layer.fill)).toBe("#eab308");
  });
});
