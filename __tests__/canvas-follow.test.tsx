import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useCanvasFollow } from "@/app/board/[boardId]/_hooks/use-canvas-follow";
import type { Camera } from "@/types/board-canvas";

import { peer, PresentationRuntime } from "./presentation-runtime";

let runtime: PresentationRuntime;
let now: number;
const initial: Camera = { x: 0, y: 0, scale: 1 };
const viewport = { width: 1000, height: 600 };

beforeEach(() => {
  runtime = new PresentationRuntime();
  now = 0;
  vi.useFakeTimers();
  vi.spyOn(performance, "now").mockImplementation(() => now);
});
afterEach(() => { cleanup(); runtime.board.destroy(); vi.useRealTimers(); vi.restoreAllMocks(); });

function advance(milliseconds: number): void {
  now += milliseconds;
  act(() => vi.advanceTimersByTime(milliseconds));
}

function setup() {
  const applyRemoteCamera = vi.fn();
  const hook = renderHook(({ camera }: { camera: Camera }) => useCanvasFollow({ camera, viewport, applyRemoteCamera }),
    { wrapper: runtime.wrapper, initialProps: { camera: initial } });
  return { ...hook, applyRemoteCamera };
}

describe("camera following lifecycle", () => {
  it("follows a terminal leader without broadcasting remote camera frames as new movements", () => {
    runtime.others = [peer(2, { center: { x: 0, y: 0 }, scale: 1, following: 3 }), peer(3)];
    const { result, rerender, applyRemoteCamera } = setup();
    act(() => result.current.toggleFollow(2));
    expect(result.current.followingId).toBe(2);
    expect(applyRemoteCamera).toHaveBeenLastCalledWith({ x: 100, y: -300, scale: 2 });
    advance(50);
    expect(runtime.self.presence.camera?.following).toBe(2);
    const publishedCount = runtime.updatePresence.mock.calls.length;
    rerender({ camera: { x: 100, y: -300, scale: 2 } });
    advance(200);
    expect(runtime.updatePresence).toHaveBeenCalledTimes(publishedCount);
    expect(runtime.board.getSnapshot().layerIds).toEqual([]);
    expect(runtime.board.undoManager.undoStack).toHaveLength(0);
  });

  it("stops on repeated clicks or manual navigation and advertises the resulting local camera", () => {
    runtime.others = [peer(2)];
    const { result, rerender } = setup();
    act(() => result.current.toggleFollow(2));
    act(() => result.current.toggleFollow(2));
    expect(result.current.followingId).toBeNull();
    act(() => result.current.toggleFollow(2));
    act(() => result.current.stopFollowing());
    rerender({ camera: { x: 50, y: -30, scale: 2 } });
    advance(50);
    expect(runtime.self.presence.camera).toEqual({ center: { x: 225, y: 165 }, scale: 2, following: null });
  });

  it("stops when a leader leaves or introduces a cycle, and cannot follow itself", () => {
    runtime.others = [peer(2)];
    const { result } = setup();
    act(() => result.current.toggleFollow(runtime.self.connectionId));
    expect(result.current.followingId).toBeNull();
    act(() => result.current.toggleFollow(2));
    act(() => runtime.setOthers([peer(2, { center: { x: 10, y: 20 }, scale: 1, following: runtime.self.connectionId })]));
    expect(result.current.followingId).toBeNull();
    act(() => runtime.setOthers([peer(2)]));
    act(() => result.current.toggleFollow(2));
    act(() => runtime.setOthers([]));
    expect(result.current.followingId).toBeNull();
  });

  it("clears queued camera state synchronously on disconnect and cancels timers on unmount", () => {
    runtime.others = [peer(2)];
    const { result, rerender, unmount } = setup();
    act(() => result.current.toggleFollow(2));
    rerender({ camera: { x: 10, y: 20, scale: 1 } });
    act(() => runtime.setState({ connected: false, synced: false }));
    expect(runtime.self.presence.camera).toBeNull();
    expect(result.current.followingId).toBeNull();
    advance(50);
    expect(runtime.self.presence.camera).toBeNull();
    unmount();
    expect(runtime.stateListeners.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });
});
