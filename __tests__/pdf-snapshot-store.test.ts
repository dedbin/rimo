// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";

import { PdfSnapshotStore } from "../server/exports/store";
import { pdfFixture } from "./pdf-fixtures";

afterEach(() => vi.useRealTimers());

describe("fixed committed PDF previews", () => {
  it("binds a random preview token to user, board and exact revision", () => {
    const store = new PdfSnapshotStore();
    const job = pdfFixture();
    const { token } = store.put("board-a", "user-a", job, []);
    expect(token).toMatch(/^[a-zA-Z0-9_-]{32}$/);
    expect(store.get(token, "board-a", "user-a").job.revision).toBe(42);
    expect(() => store.get(token, "board-a", "user-b")).toThrow();
    expect(() => store.get(token, "board-b", "user-a")).toThrow();
    store.delete(token, "board-a", "user-a");
    expect(() => store.get(token, "board-a", "user-a")).toThrow();
  });

  it("expires snapshots automatically even if nobody makes another request", async () => {
    vi.useFakeTimers();
    const store = new PdfSnapshotStore(100);
    const { token } = store.put("board", "user", pdfFixture(), []);
    await vi.advanceTimersByTimeAsync(101);
    expect(() => store.get(token, "board", "user")).toThrow();
  });

  it("enforces total memory and per-user preview count", () => {
    const source = pdfFixture();
    const bytes = Buffer.byteLength(JSON.stringify(source));
    const bounded = new PdfSnapshotStore(1000, bytes * 2);
    bounded.put("board", "first", source, []);
    bounded.put("board", "second", source, []);
    expect(() => bounded.put("board", "third", source, [])).toThrow();
    const store = new PdfSnapshotStore();
    const old = store.put("board", "user", source, []);
    store.put("board", "user", source, []);
    store.put("board", "user", source, []);
    expect(() => store.get(old.token, "board", "user")).toThrow();
  });

  it("releases the preparation budget after a failure", async () => {
    const store = new PdfSnapshotStore();
    let release!: () => void;
    const blocker = new Promise<void>((resolve) => { release = resolve; });
    const first = store.prepare(async () => blocker);
    const second = store.prepare(async () => blocker);
    await expect(store.prepare(async () => undefined)).rejects.toMatchObject({ status: 429 });
    release();
    await Promise.all([first, second]);
    await expect(store.prepare(async () => { throw new Error("failed"); })).rejects.toThrow("failed");
    await expect(store.prepare(async () => "ready")).resolves.toBe("ready");
  });

  it("rejects excess worker requests before allocating another serialized asset payload", async () => {
    const store = new PdfSnapshotStore();
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const jobs = Array.from({ length: 3 }, () => store.dispatch(async () => pending));
    await expect(store.dispatch(async () => "overflow")).rejects.toMatchObject({ status: 429 });
    release();
    await Promise.all(jobs);
    await expect(store.dispatch(async () => "ready")).resolves.toBe("ready");
  });
});
