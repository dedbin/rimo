import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";

import { Line } from "@/app/board/[boardId]/_components/line";
import { parseClipboardLayers, serializeLayers, offsetLayers } from "@/lib/board/clipboard";
import { createLine, lineBounds, lineDashPattern, lineEndpoints } from "@/lib/board/line";
import { parseLayer } from "@/lib/board/model";
import { BoardDocument } from "@/lib/collaboration/document";
import type { LineLayer } from "@/types/board-canvas";

const color = { r: 15, g: 23, b: 42 };

afterEach(cleanup);

describe("dashed line compatibility and editing", () => {
  it("keeps old lines solid and rejects unsupported styles", () => {
    const legacy = createLine({ x: 10, y: 20 }, { x: 200, y: 20 }, color);
    delete legacy.strokeStyle;
    expect(parseLayer(legacy)).toEqual(legacy);
    expect(lineDashPattern(legacy, { x: 10, y: 20 })).toBeNull();
    for (const strokeStyle of ["dotted", "", null, true, 3, {}, []]) {
      expect(parseLayer({ ...legacy, strokeStyle })).toBeNull();
    }
    expect(parseLayer({ ...legacy, strokeStyle: "solid" })).toMatchObject({ strokeStyle: "solid" });
    expect(parseLayer({ ...legacy, strokeStyle: "dashed" })).toMatchObject({ strokeStyle: "dashed" });
  });

  it("retains dash style through clipboard, offsets and native document reload", () => {
    const line = { ...createLine({ x: 200, y: 50 }, { x: 20, y: 50 }, color, "segment", "dashed"), endArrow: true };
    const copied = parseClipboardLayers(serializeLayers([line]));
    expect(copied).toEqual([line]);
    const shifted = offsetLayers(copied!, 400, 100) as LineLayer[];
    expect(shifted[0]).toMatchObject({ strokeStyle: "dashed", endArrow: true });
    const local = new BoardDocument();
    const remote = new BoardDocument();
    try {
      const [id] = local.insert(shifted);
      Y.applyUpdate(remote.doc, Y.encodeStateAsUpdate(local.doc), "peer");
      expect(remote.getLayer(id)).toEqual(shifted[0]);
      expect(lineEndpoints(remote.getLayer(id) as LineLayer)).toEqual([{ x: 580, y: 100 }, { x: 400, y: 100 }]);
    } finally { local.destroy(); remote.destroy(); }
  });

  it("undoes endpoint movement without losing a peer's dash style", () => {
    const local = new BoardDocument();
    const peer = new BoardDocument();
    try {
      const initial = createLine({ x: 0, y: 0 }, { x: 100, y: 0 }, color);
      const [id] = local.insert([initial]);
      Y.applyUpdate(peer.doc, Y.encodeStateAsUpdate(local.doc), "peer");
      local.update([id], lineBounds({ x: 20, y: 80 }, { x: 100, y: 0 }));
      peer.update([id], { strokeStyle: "dashed" });
      Y.applyUpdate(local.doc, Y.encodeStateAsUpdate(peer.doc), "peer");
      local.undo();
      expect(lineEndpoints(local.getLayer(id) as LineLayer)).toEqual(lineEndpoints(initial));
      expect(local.getLayer(id)).toMatchObject({ strokeStyle: "dashed" });
      local.redo();
      expect(local.getLayer(id)).toMatchObject({ strokeStyle: "dashed" });
      expect(lineEndpoints(local.getLayer(id) as LineLayer)).toEqual([{ x: 20, y: 80 }, { x: 100, y: 0 }]);
    } finally { local.destroy(); peer.destroy(); }
  });
});

describe("dashed line rendering", () => {
  it("draws only the line body dashed and keeps arrows and hit target solid", () => {
    const layer = { ...createLine({ x: 10, y: 20 }, { x: 200, y: 20 }, color, "segment", "dashed"),
      strokeWidth: 4, startArrow: true, endArrow: true };
    const onPointerDown = vi.fn();
    const view = render(<svg><Line id="dashed" layer={layer} onPointerDown={onPointerDown} /></svg>);
    const body = view.container.querySelector("[data-line-body]")!;
    expect(body.getAttribute("stroke-dasharray")).toBe("16 12");
    expect(body.getAttribute("stroke-dashoffset")).toBe("0");
    const hit = view.container.querySelector("[data-line-hit]")!;
    expect(hit.hasAttribute("stroke-dasharray")).toBe(false);
    fireEvent.pointerDown(hit, { button: 0 });
    expect(onPointerDown).toHaveBeenCalledOnce();
    const arrows = [...view.container.querySelectorAll("polygon")];
    expect(arrows).toHaveLength(2);
    expect(arrows.every((arrow) => !arrow.hasAttribute("stroke-dasharray"))).toBe(true);
  });

  it("anchors an infinite line's pattern to its control point when the viewport moves", () => {
    const layer = createLine({ x: 0, y: 50 }, { x: 100, y: 50 }, color, "line", "dashed");
    const view = render(<svg><Line id="infinite" layer={layer} viewport={{ x: 5, y: 0, width: 100, height: 100 }} /></svg>);
    let body = view.container.querySelector("[data-line-body]")!;
    expect(body.getAttribute("stroke-dashoffset")).toBe("5");
    view.rerender(<svg><Line id="infinite" layer={layer} viewport={{ x: -3, y: 0, width: 100, height: 100 }} /></svg>);
    body = view.container.querySelector("[data-line-body]")!;
    expect(body.getAttribute("stroke-dashoffset")).toBe("11");
    expect(lineDashPattern({ ...layer, strokeWidth: 4 }, { x: 100, y: 50 })?.array).toBe("16 12");
  });
});
