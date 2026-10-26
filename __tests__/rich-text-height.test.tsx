import { createRef } from "react";
import { cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useContentHeight } from "@/components/board-text/use-content-height";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("text height measurement", () => {
  it("measures unscaled content height and disconnects its observer on unmount", () => {
    let observerCallback: (() => void) | null = null;
    const disconnect = vi.fn();
    vi.stubGlobal("ResizeObserver", class {
      constructor(callback: () => void) { observerCallback = callback; }
      observe = vi.fn();
      disconnect = disconnect;
    });
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { callback(0); return 1; });
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    const element = createRef<HTMLDivElement>();
    const div = document.createElement("div");
    Object.defineProperty(element, "current", { value: div });
    Object.defineProperty(div, "scrollHeight", { value: 100, configurable: true });
    Object.defineProperty(div, "offsetHeight", { value: 100, configurable: true });
    Object.defineProperty(div, "getBoundingClientRect", { value: () => ({ height: 400 }) });
    const notify = vi.fn();
    const { unmount } = renderHook(() => useContentHeight(element, notify));
    expect(notify).toHaveBeenLastCalledWith(100);
    Object.defineProperty(div, "scrollHeight", { value: 150 });
    (observerCallback as (() => void) | null)?.();
    expect(notify).toHaveBeenLastCalledWith(150);
    unmount();
    expect(disconnect).toHaveBeenCalledOnce();
  });
});
