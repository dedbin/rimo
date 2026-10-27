// @vitest-environment node
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

import { afterEach, describe, expect, it, vi } from "vitest";

import { startProbe } from "../scripts/performance/pdf-lesson/probe.mjs";

const mocked = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("node:child_process", async (original) => ({ ...await original<typeof import("node:child_process")>(), spawn: mocked.spawn }));

type Mode = "valid" | "wrong-id" | "wrong-kind" | "sequence-gap" | "duplicate" | "silent";
class ProbeProcess extends EventEmitter {
  stdin = new PassThrough(); stdout = new PassThrough(); stderr = new PassThrough();
  kill = vi.fn(() => { this.emit("exit", 0); return true; });
  maximumHealthInFlight = 0;
  commands: { kind: string; id?: number }[] = [];
  private sequence = 0;
  private healthInFlight = 0;
  private stopped = false;

  constructor(private readonly mode: Mode) {
    super();
    this.stdin.on("data", (chunk: Buffer) => {
      for (const line of chunk.toString().trim().split("\n")) {
        const command = JSON.parse(line) as { kind: string; id?: number }; this.commands.push(command);
        if (command.kind === "stop") {
          this.stopped = true; this.stdout.end(); this.stderr.end(); this.emit("exit", 0); continue;
        }
        if (command.kind === "memory") {
          this.reply({ kind: "memory", id: command.id, cgroupCurrentBytes: 1_000, cgroupLimitBytes: 10_000, pid1RssBytes: 500 }); continue;
        }
        this.healthInFlight += 1;
        this.maximumHealthInFlight = Math.max(this.maximumHealthInFlight, this.healthInFlight);
        if (this.mode === "silent") continue;
        setTimeout(() => {
          this.healthInFlight -= 1;
          const reply = { kind: this.mode === "wrong-kind" ? "memory" : "health", id: this.mode === "wrong-id" ? 99_999 : command.id,
            sequence: ++this.sequence + (this.mode === "sequence-gap" ? 1 : 0), ok: true, running: false, waiting: 0,
            atEpochMs: 900_000 - this.sequence * 5_000, monotonicMs: this.sequence * 0.92, startedMonotonicMs: this.sequence * 0.91 };
          this.reply(reply);
          if (this.mode === "duplicate") setTimeout(() => this.reply(reply), 10);
        }, 2);
      }
    });
    setTimeout(() => this.reply({ kind: "ready" }), 1);
  }

  private reply(value: object) { if (!this.stopped) this.stdout.write(`${JSON.stringify(value)}\n`); }
}

const binding = { worker: { id: "a".repeat(64) } };
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); mocked.spawn.mockReset(); });

describe("PDF causal probe control pipe without a child process or service", () => {
  it("correlates actual stdin/stdout records, keeps one health in flight, and closes independently", async () => {
    vi.useFakeTimers();
    const child = new ProbeProcess("valid"); mocked.spawn.mockReturnValue(child);
    const starting = startProbe(binding, new AbortController().signal);
    await vi.advanceTimersByTimeAsync(150);
    const probe = await starting;
    expect(mocked.spawn).toHaveBeenCalledTimes(1);
    expect(probe.samples.length).toBeGreaterThanOrEqual(3);
    expect(child.maximumHealthInFlight).toBe(1);
    for (const [index, sample] of probe.samples.entries()) {
      expect(sample.replyId).toBe(sample.requestId); expect(sample.sequence).toBe(index + 1);
      expect(sample.hostReceivedAt).toBeGreaterThanOrEqual(sample.hostSentAt);
      if (index) expect(sample.hostSentAt).toBeGreaterThanOrEqual(probe.samples[index - 1].hostReceivedAt);
    }
    const memory = probe.memoryNow(); await vi.advanceTimersByTimeAsync(1);
    expect(await memory).toMatchObject({ cgroupCurrentBytes: 1_000 });
    const closing = probe.close(); await vi.advanceTimersByTimeAsync(50); await closing;
    expect(child.commands.at(-1)?.kind).toBe("stop"); expect(child.kill).not.toHaveBeenCalled();
    const count = probe.samples.length; await vi.advanceTimersByTimeAsync(100);
    expect(probe.samples).toHaveLength(count);
  });

  it.each<Mode>(["wrong-id", "wrong-kind", "sequence-gap", "duplicate"])("rejects%s through the real pending-map reader and stops the owned probe", async (mode) => {
    vi.useFakeTimers();
    const child = new ProbeProcess(mode); mocked.spawn.mockReturnValue(child);
    const rejected = expect(startProbe(binding, new AbortController().signal)).rejects.toThrow(/invalid correlated/i);
    await vi.advanceTimersByTimeAsync(200); await rejected;
    expect(child.commands.at(-1)?.kind).toBe("stop"); expect(child.kill).not.toHaveBeenCalled();
  });

  it.each(["stdout", "stderr"] as const)("handles%s failure while health is pending, preserves a safe error, and stops the owned probe", async (pipe) => {
    vi.useFakeTimers();
    const child = new ProbeProcess("silent"); mocked.spawn.mockReturnValue(child);
    const starting = startProbe(binding, new AbortController().signal);
    const rejected = expect(starting).rejects.toThrow("Worker probe returned an invalid correlated record");
    await vi.advanceTimersByTimeAsync(40);
    expect(child.commands.some((entry) => entry.kind === "health")).toBe(true);
    expect(() => child[pipe].emit("error", new Error("Private pipe diagnostic must not escape"))).not.toThrow();
    await vi.advanceTimersByTimeAsync(100); await rejected;
    const error = await starting.catch((failure: Error) => failure);
    expect(String(error)).not.toContain("Private pipe diagnostic");
    expect(child.commands.at(-1)?.kind).toBe("stop"); expect(child.kill).not.toHaveBeenCalled();
    const count = child.commands.length; await vi.advanceTimersByTimeAsync(10_000);
    expect(child.commands).toHaveLength(count);
  });

  it("keeps stdout/stderr errors handled after readline closes during teardown", async () => {
    vi.useFakeTimers();
    const child = new ProbeProcess("valid"); mocked.spawn.mockReturnValue(child);
    const starting = startProbe(binding, new AbortController().signal);
    await vi.advanceTimersByTimeAsync(100); const probe = await starting;
    const closing = probe.close(); await vi.advanceTimersByTimeAsync(50); await closing;
    expect(child.stdout.listenerCount("error")).toBeGreaterThanOrEqual(1);
    expect(() => child.stdout.emit("error", new Error("Late stdout error"))).not.toThrow();
    expect(() => child.stderr.emit("error", new Error("Late stderr error"))).not.toThrow();
    expect(() => probe.check()).toThrow("Worker probe returned an invalid correlated record");
    expect(child.commands.at(-1)?.kind).toBe("stop"); expect(child.kill).not.toHaveBeenCalled();
  });

  it("aborts an unanswered health request and still sends stop without a leaked polling loop", async () => {
    vi.useFakeTimers();
    const child = new ProbeProcess("silent"); mocked.spawn.mockReturnValue(child);
    const controller = new AbortController();
    const rejected = expect(startProbe(binding, controller.signal)).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(40); controller.abort();
    await vi.advanceTimersByTimeAsync(100); await rejected;
    expect(child.maximumHealthInFlight).toBe(1); expect(child.commands.at(-1)?.kind).toBe("stop");
    const count = child.commands.length; await vi.advanceTimersByTimeAsync(10_000);
    expect(child.commands).toHaveLength(count); expect(child.kill).not.toHaveBeenCalled();
  });
});
