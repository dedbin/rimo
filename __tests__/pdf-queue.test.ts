// @vitest-environment node
import { describe, expect, it } from "vitest";

import { PdfQueue } from "../export-worker/queue";

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("one Chromium job and bounded queue", () => {
  it("runs one operation, queues two and rejects a fourth before it allocates a browser", async () => {
    const queue = new PdfQueue();
    const release = deferred();
    const called: number[] = [];
    const first = queue.run(async () => { called.push(1); await release.promise; return 1; });
    const second = queue.run(async () => { called.push(2); return 2; });
    const third = queue.run(async () => { called.push(3); return 3; });
    await expect(queue.run(async () => 4)).rejects.toMatchObject({ code: "PDF_BUSY" });
    expect(called).toEqual([1]);
    expect(queue.status).toEqual({ running: true, waiting: 2 });
    release.resolve();
    expect(await Promise.all([first, second, third])).toEqual([1, 2, 3]);
    expect(called).toEqual([1, 2, 3]);
  });

  it("removes cancelled queued jobs and does not interrupt another user's render", async () => {
    const queue = new PdfQueue();
    const release = deferred();
    const first = queue.run(async () => { await release.promise; return "kept"; });
    const cancelled = new AbortController();
    const second = queue.run(async () => "never", cancelled.signal);
    cancelled.abort(new Error("cancelled"));
    await expect(second).rejects.toThrow("cancelled");
    expect(queue.status.waiting).toBe(0);
    release.resolve();
    await expect(first).resolves.toBe("kept");
  });

  it("bounds total time from enqueue and waits for active cleanup before the next operation", async () => {
    const queue = new PdfQueue(2, 20);
    const events: string[] = [];
    const first = queue.run(async (signal) => {
      await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
      events.push("cleanup");
      throw signal.reason;
    });
    const second = queue.run(async (signal) => { signal.throwIfAborted(); events.push("next"); return true; });
    const settled = await Promise.allSettled([first, second]);
    expect(settled[0]).toMatchObject({ status: "rejected", reason: { code: "PDF_TIMEOUT" } });
    expect(events[0]).toBe("cleanup");
  });

  it("returns a deadline error even while a stuck operation is still being terminated", async () => {
    const queue = new PdfQueue(2, 10);
    const stuck = queue.run(async () => new Promise<never>(() => undefined));
    await expect(stuck).rejects.toMatchObject({ code: "PDF_TIMEOUT" });
    expect(queue.status.running).toBe(true);
  });
});
