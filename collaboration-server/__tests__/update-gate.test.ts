// @vitest-environment node
import { setImmediate as nextTurn } from "node:timers/promises";

import { describe, expect, it } from "vitest";

import { UpdateGate } from "../update-gate";

describe("document update gate", () => {
  it("keeps FIFO and ignores release of a ticket that is still waiting", async () => {
    const gate = new UpdateGate();
    const order: string[] = [];
    await gate.acquire("board", "first");
    const second = gate.acquire("board", "second").then(() => order.push("second"));
    const third = gate.acquire("board", "third").then(() => order.push("third"));
    gate.release("second");
    await nextTurn();
    expect(order).toEqual([]);
    gate.release("first");
    await second;
    expect(order).toEqual(["second"]);
    gate.release("second");
    gate.release("second");
    await third;
    expect(order).toEqual(["second", "third"]);
    gate.release("third");
  });

  it("lets different boards progress independently", async () => {
    const gate = new UpdateGate();
    await gate.acquire("first-board", "first");
    await gate.acquire("second-board", "second");
    gate.release("first");
    gate.release("second");
  });

  it("releases the next update after a failed operation", async () => {
    const gate = new UpdateGate();
    const first = (async () => {
      await gate.acquire("board", "first");
      try { throw new Error("Rejected update"); }
      finally { gate.release("first"); }
    })();
    await expect(first).rejects.toThrow("Rejected update");
    await gate.acquire("board", "second");
    gate.release("second");
  });

  it.each([false, true])("gives I/O a turn between updates (prequeued=%s)", async (prequeued) => {
    const gate = new UpdateGate();
    const trace: string[] = [];
    let io: Promise<void> = Promise.resolve();
    const update = async (index: number) => {
      await gate.acquire("board", `writer-${index}`);
      trace.push(`write-${index}`);
      if (index === 0) io = nextTurn().then(() => { trace.push("io"); });
      gate.release(`writer-${index}`);
    };
    if (prequeued) await Promise.all([0, 1, 2, 3].map(update));
    else for (let index = 0; index < 4; index += 1) await update(index);
    await io;
    expect(trace.slice(0, 3)).toEqual(["write-0", "io", "write-1"]);
    expect(trace.filter((entry) => entry.startsWith("write-"))).toEqual(["write-0", "write-1", "write-2", "write-3"]);
  });
});
