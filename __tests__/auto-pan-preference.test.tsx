import { act, cleanup, renderHook } from "@testing-library/react";
import { hydrateRoot, type Root } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useAutoPanPreference } from "@/app/board/[boardId]/_hooks/use-auto-pan-preference";

const STORAGE_KEY = "rimo:auto-pan:v1";

function Preview() {
  const { enabled, loaded } = useAutoPanPreference();
  return <output>{`${enabled}:${loaded}`}</output>;
}

beforeEach(() => localStorage.clear());
afterEach(() => { cleanup(); vi.restoreAllMocks(); localStorage.clear(); });

describe("browser edge auto-pan preference", () => {
  it("renders the server default without reading or overwriting stored preferences", () => {
    localStorage.setItem(STORAGE_KEY, "false");
    const read = vi.spyOn(Storage.prototype, "getItem");
    const write = vi.spyOn(Storage.prototype, "setItem");
    expect(renderToString(<Preview />)).toContain("true:false");
    expect(read).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
  });

  it("hydrates safely before applying the saved disabled preference", async () => {
    localStorage.setItem(STORAGE_KEY, "false");
    const container = document.createElement("div");
    container.innerHTML = renderToString(<Preview />);
    document.body.appendChild(container);
    const recoverableError = vi.fn();
    const write = vi.spyOn(Storage.prototype, "setItem");
    let root: Root | undefined;
    try {
      await act(async () => { root = hydrateRoot(container, <Preview />, { onRecoverableError: recoverableError }); });
      expect(recoverableError).not.toHaveBeenCalled();
      expect(container.textContent).toBe("false:true");
      expect(write).not.toHaveBeenCalled();
      expect(localStorage.getItem(STORAGE_KEY)).toBe("false");
    } finally {
      act(() => root?.unmount());
      container.remove();
    }
  });

  it.each([null, "true", "invalid", "", "0", "FALSE"])("starts enabled for stored value %s", (raw) => {
    if (raw !== null) localStorage.setItem(STORAGE_KEY, raw);
    const { result } = renderHook(() => useAutoPanPreference());
    expect(result.current.enabled).toBe(true);
    expect(result.current.loaded).toBe(true);
  });

  it("persists a switch change across board mounts and lets it be enabled again", () => {
    const first = renderHook(() => useAutoPanPreference());
    act(() => first.result.current.setEnabled(false));
    expect(first.result.current.enabled).toBe(false);
    expect(localStorage.getItem(STORAGE_KEY)).toBe("false");
    first.unmount();

    const secondBoard = renderHook(() => useAutoPanPreference());
    expect(secondBoard.result.current.enabled).toBe(false);
    act(() => secondBoard.result.current.setEnabled(true));
    expect(localStorage.getItem(STORAGE_KEY)).toBe("true");
    secondBoard.unmount();

    expect(renderHook(() => useAutoPanPreference()).result.current.enabled).toBe(true);
  });

  it("keeps the switch working when browser storage cannot be read or written", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new DOMException("denied", "SecurityError"); });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new DOMException("full", "QuotaExceededError"); });
    const { result } = renderHook(() => useAutoPanPreference());
    expect(result.current.enabled).toBe(true);
    expect(result.current.loaded).toBe(true);
    expect(() => act(() => result.current.setEnabled(false))).not.toThrow();
    expect(result.current.enabled).toBe(false);
    act(() => result.current.setEnabled(true));
    expect(result.current.enabled).toBe(true);
  });
});
