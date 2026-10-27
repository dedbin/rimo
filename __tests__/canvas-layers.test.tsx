import { useEffect } from "react";
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { BoardSnapshot } from "@/lib/collaboration/document";
import { createLayer } from "@/lib/board/model";
import { LayerType } from "@/types/board-canvas";
import { CanvasLayers } from "@/app/board/[boardId]/_components/canvas-layers";

const lifecycle = vi.hoisted(() => ({ mounted: [] as string[], unmounted: [] as string[] }));
vi.mock("@/app/board/[boardId]/_components/layer-preview", () => ({
  LayerPreview: ({ id }: { id: string }) => {
    useEffect(() => {
      lifecycle.mounted.push(id);
      return () => { lifecycle.unmounted.push(id); };
    }, [id]);
    return <rect data-shape={id} />;
  },
}));

afterEach(() => { cleanup(); lifecycle.mounted.length = 0; lifecycle.unmounted.length = 0; });

describe("stable preview layers", () => {
  it("raises and restores existing nodes without remounting their content", () => {
    const ids = ["first", "middle", "last"];
    const snapshot: BoardSnapshot = {
      layerIds: ids, frames: new Map(), frameIds: [],
      layers: new Map(ids.map((id) => [id, createLayer(LayerType.Rectangle, { x: 0, y: 0 }, { r: 0, g: 0, b: 0 })])),
    };
    const props = { snapshot, visibleIds: ids, movingIds: new Set<string>(), previewIds: [] as string[],
      erased: null, resize: null, remoteTransforms: new Map([["first", { x: 8, y: 9 }]]),
      selectionColors: {}, onLayerPointerDown: vi.fn() };
    const nodes = (container: HTMLElement) => [...container.querySelectorAll<SVGGElement>("g[data-layer-id]")];
    const view = render(<svg><CanvasLayers {...props} /></svg>);
    const originals = nodes(view.container);
    const firstContent = originals[0].firstElementChild;
    expect(originals[0].getAttribute("transform")).toBe("translate(8 9)");

    view.rerender(<svg><CanvasLayers {...props} movingIds={new Set(["first"])} previewIds={["first"]} /></svg>);
    expect(nodes(view.container)).toEqual([originals[1], originals[2], originals[0]]);
    expect(originals[0].firstElementChild).toBe(firstContent);
    expect(originals[0].hasAttribute("transform")).toBe(false);
    expect(originals[0].style.transform).toContain("var(--rimo-preview-x)");
    expect(lifecycle.mounted).toEqual(ids);
    expect(lifecycle.unmounted).toEqual([]);

    view.rerender(<svg><CanvasLayers {...props} /></svg>);
    expect(nodes(view.container)).toEqual(originals);
    expect(originals[0].firstElementChild).toBe(firstContent);
    expect(originals[0].getAttribute("transform")).toBe("translate(8 9)");
    expect(lifecycle.unmounted).toEqual([]);
  });
});
