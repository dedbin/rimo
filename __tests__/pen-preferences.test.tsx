import { act, cleanup, renderHook } from "@testing-library/react";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { usePenPreferences } from "@/app/board/[boardId]/_hooks/use-pen-preferences";
import { defaultPenPreferences, penPreferencesKey } from "@/lib/board/pen-preferences";
import type { Color } from "@/types/board-canvas";

const BLUE: Color = { r: 59, g: 130, b: 246 };
const RED: Color = { r: 239, g: 68, b: 68 };

function store(userId: string, color: Color, size: number): void {
  localStorage.setItem(penPreferencesKey(userId), JSON.stringify({ version: 1, color, size }));
}

beforeEach(() => localStorage.clear());
afterEach(() => { cleanup(); vi.restoreAllMocks(); localStorage.clear(); });

describe("personal marker preferences", () => {
  it("renders the same safe defaults on the server without consulting browser storage", () => {
    store("teacher", BLUE, 24);
    const read = vi.spyOn(Storage.prototype, "getItem");
    function ServerPreview() {
      const preferences = usePenPreferences("teacher");
      return <output>{JSON.stringify({ color: preferences.color, size: preferences.size })}</output>;
    }
    const html = renderToString(<ServerPreview />);
    expect(html).toContain("&quot;size&quot;:16");
    expect(html).toContain("&quot;r&quot;:0");
    expect(read).not.toHaveBeenCalled();
  });

  it("restores preferences after remount without writing defaults over the saved value", () => {
    store("teacher", BLUE, 24);
    const first = renderHook(() => usePenPreferences("teacher"));
    expect(first.result.current.color).toEqual(BLUE);
    expect(first.result.current.size).toBe(24);
    act(() => { first.result.current.setColor(RED); first.result.current.setSize(4); });
    first.unmount();
    const reopened = renderHook(() => usePenPreferences("teacher"));
    expect(reopened.result.current.color).toEqual(RED);
    expect(reopened.result.current.size).toBe(4);
  });

  it("keeps users and already mounted marker instances independent", () => {
    const teacher = renderHook(() => usePenPreferences("teacher"));
    const pupil = renderHook(() => usePenPreferences("pupil"));
    act(() => { teacher.result.current.setColor(RED); teacher.result.current.setSize(4); });
    act(() => { pupil.result.current.setColor(BLUE); pupil.result.current.setSize(24); });
    expect(teacher.result.current.color).toEqual(RED);
    expect(teacher.result.current.size).toBe(4);
    expect(pupil.result.current.color).toEqual(BLUE);
    expect(pupil.result.current.size).toBe(24);
    expect(JSON.parse(localStorage.getItem(penPreferencesKey("teacher"))!)).toMatchObject({ color: RED, size: 4 });
    expect(JSON.parse(localStorage.getItem(penPreferencesKey("pupil"))!)).toMatchObject({ color: BLUE, size: 24 });

    store("teacher", BLUE, 32);
    act(() => window.dispatchEvent(new StorageEvent("storage", {
      key: penPreferencesKey("teacher"), newValue: localStorage.getItem(penPreferencesKey("teacher")),
    })));
    expect(teacher.result.current.color).toEqual(RED);
    expect(teacher.result.current.size).toBe(4);
  });

  it("switches accounts without copying the previous account's settings", () => {
    store("teacher", RED, 4);
    store("pupil", BLUE, 24);
    const hook = renderHook(({ userId }) => usePenPreferences(userId), { initialProps: { userId: "teacher" } });
    hook.rerender({ userId: "pupil" });
    expect(hook.result.current.color).toEqual(BLUE);
    expect(hook.result.current.size).toBe(24);
    expect(JSON.parse(localStorage.getItem(penPreferencesKey("teacher"))!)).toMatchObject({ color: RED, size: 4 });
    act(() => hook.result.current.setSize(32));
    hook.rerender({ userId: "teacher" });
    expect(hook.result.current.color).toEqual(RED);
    expect(hook.result.current.size).toBe(4);
    expect(JSON.parse(localStorage.getItem(penPreferencesKey("pupil"))!)).toMatchObject({ color: BLUE, size: 32 });
  });

  it("preserves opacity across RGB and width changes, reload and account changes", () => {
    store("teacher", { ...BLUE, a: 0.25 }, 24);
    store("pupil", { ...RED, a: 0.5 }, 8);
    const hook = renderHook(({ userId }) => usePenPreferences(userId), { initialProps: { userId: "teacher" } });
    act(() => { hook.result.current.setColor(RED); hook.result.current.setSize(32); });
    expect(hook.result.current.color).toEqual({ ...RED, a: 0.25 });
    hook.rerender({ userId: "pupil" });
    expect(hook.result.current.color).toEqual({ ...RED, a: 0.5 });
    expect(hook.result.current.size).toBe(8);
    hook.unmount();

    const reloaded = renderHook(() => usePenPreferences("teacher"));
    expect(reloaded.result.current.color).toEqual({ ...RED, a: 0.25 });
    expect(reloaded.result.current.size).toBe(32);
    expect(JSON.parse(localStorage.getItem(penPreferencesKey("teacher"))!)).toEqual({
      version: 1, color: { ...RED, a: 0.25 }, size: 32,
    });
    act(() => reloaded.result.current.setColor({ ...BLUE, a: 1 }));
    expect(reloaded.result.current.color).toEqual({ ...BLUE, a: 1 });
  });

  it.each([
    "not-json", "null", "[]", JSON.stringify({ version: 2, color: BLUE, size: 24 }),
    JSON.stringify({ version: 1, color: { r: -1, g: 130, b: 246 }, size: 24 }),
    JSON.stringify({ version: 1, color: { r: 59, g: 130, b: 246, a: 2 }, size: 24 }),
    JSON.stringify({ version: 1, color: BLUE, size: 999999 }),
  ])("recovers from invalid stored settings: %s", (raw) => {
    localStorage.setItem(penPreferencesKey("teacher"), raw);
    const { result } = renderHook(() => usePenPreferences("teacher"));
    expect({ color: result.current.color, size: result.current.size }).toEqual(defaultPenPreferences());
  });

  it("keeps drawing preferences usable when browser storage is denied", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new DOMException("denied", "SecurityError"); });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new DOMException("full", "QuotaExceededError"); });
    const { result } = renderHook(() => usePenPreferences("teacher"));
    expect(() => act(() => { result.current.setColor(BLUE); result.current.setSize(24); })).not.toThrow();
    expect(result.current.color).toEqual(BLUE);
    expect(result.current.size).toBe(24);
  });

  it("copies the supplied color and ignores unsupported sizes", () => {
    const { result } = renderHook(() => usePenPreferences("teacher"));
    const color = { ...BLUE };
    act(() => { result.current.setColor(color); result.current.setSize(Number.NaN); });
    color.r = 0;
    expect(result.current.color).toEqual(BLUE);
    expect(result.current.size).toBe(16);
  });
});
