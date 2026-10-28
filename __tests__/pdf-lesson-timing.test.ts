// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";

import { causalObservationsValid, healthRecord } from "../scripts/performance/pdf-lesson/causal.mjs";
import { browserClockCompatible, clockBounds, hostNow } from "../scripts/performance/pdf-lesson/clock.mjs";
import { overlapEvidence } from "../scripts/performance/pdf-lesson/criteria.mjs";
import { prepareMove } from "../scripts/performance/pdf-lesson/input.mjs";

const browserClock = { stable: true, lower: -1, upper: 1, uncertaintyMs: 2 };
const echoes = [{ sentAt: 1_100, receivedAt: 1_104, probeAt: 1_100 }, { sentAt: 1_200, receivedAt: 1_204, probeAt: 1_200 }];
const samples = [
  { requestId: 1, replyId: 1, sequence: 1, hostSentAt: 1_100, hostReceivedAt: 1_105,
    remoteAtEpochMs: 500_000, remoteMonotonicMs: 100, ok: true, running: true, waiting: 0 },
  { requestId: 3, replyId: 3, sequence: 2, hostSentAt: 1_195, hostReceivedAt: 1_205,
    remoteAtEpochMs: 500_100, remoteMonotonicMs: 200, ok: true, running: true, waiting: 0 },
];
const operation = { pointerUpAt: 1_150, sourceClock: browserClock, probeStartSequence: 0, probeEndSequence: 2,
  pdf: { requestStartEpochMs: 1_050, bodyEndEpochMs: 1_250, clock: browserClock } };

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("PDF lesson causal occupancy timing", () => {
  it.each([5_250, -5_250, 3_600_000])("ignores remote wall/monotonic jumps of %sms without manufacturing overlap", (jump) => {
    const changedSamples = samples.map((entry, index) => ({ ...entry, remoteAtEpochMs: entry.remoteAtEpochMs + index * jump,
      remoteMonotonicMs: entry.remoteMonotonicMs - index * jump }));
    expect(causalObservationsValid(changedSamples)).toBe(true);
    expect(overlapEvidence(operation, changedSamples)).toEqual(overlapEvidence(operation, samples));
    expect(overlapEvidence({ ...operation, pointerUpAt: 1_500 }, changedSamples)).toBeNull();
  });

  it("does not infer clock stability when worker time runs8%slower than the host", () => {
    const changed = samples.map((entry, index) => ({ ...entry, remoteMonotonicMs: 100 + index * 92 }));
    expect(causalObservationsValid(changed)).toBe(true);
    expect(overlapEvidence(operation, changed)).not.toBeNull();
  });

  it.each(["host-backwards", "sequence-gap", "sequence-duplicate", "reply-id", "request-out-of-order", "overlapping-requests", "nonfinite-send", "nonfinite-receive"])("rejects invalid causal chronology: %s", (invalid) => {
    const changed = structuredClone(samples);
    if (invalid === "host-backwards") changed[1].hostReceivedAt = 1_000;
    if (invalid === "sequence-gap") changed[1].sequence = 3;
    if (invalid === "sequence-duplicate") changed[1].sequence = 1;
    if (invalid === "reply-id") changed[1].replyId = 99;
    if (invalid === "request-out-of-order") changed[1].requestId = changed[1].replyId = 1;
    if (invalid === "overlapping-requests") changed[1].hostSentAt = 1_104;
    if (invalid === "nonfinite-send") changed[1].hostSentAt = Number.NaN;
    if (invalid === "nonfinite-receive") changed[1].hostReceivedAt = Number.POSITIVE_INFINITY;
    expect(causalObservationsValid(changed)).toBe(false);
    expect(overlapEvidence(operation, changed)).toBeNull();
  });

  it("binds a reply to actual runner send/receive bounds and rejects a mismatchedID or kind", () => {
    const request = { kind: "health", id: 1, hostSentAt: 1_100 };
    const reply = { kind: "health", id: 1, sequence: 1, ok: true, running: true, waiting: 0, hostSentAt: 0, hostReceivedAt: 0 };
    expect(healthRecord(reply, request, undefined, 1_105)).toMatchObject({ requestId: 1, replyId: 1, hostSentAt: 1_100, hostReceivedAt: 1_105 });
    expect(() => healthRecord({ ...reply, id: 99 }, request, undefined, 1_105)).toThrow();
    expect(() => healthRecord({ ...reply, kind: "memory" }, request, undefined, 1_105)).toThrow();
    expect(() => healthRecord(reply, request, undefined, 1_099)).toThrow();
  });

  it("rejects more than50ms uncertainty, a corrupt echo, and an unmeasured browser offset", () => {
    expect(clockBounds([{ sentAt: 0, receivedAt: 49, probeAt: 0 }]).stable).toBe(false);
    expect(clockBounds([{ sentAt: 0, receivedAt: 48, probeAt: 0 }]).stable).toBe(true);
    expect(clockBounds([...echoes, { sentAt: Number.NaN, receivedAt: 1_304, probeAt: 1_200 }]).stable).toBe(false);
    expect(browserClockCompatible(undefined)).toBe(false);
    expect(browserClockCompatible({ ...browserClock, lower: -6 })).toBe(false);
    expect(browserClockCompatible({ ...browserClock, upper: 6 })).toBe(false);
    expect(browserClockCompatible({ ...browserClock, lower: Number.NaN })).toBe(false);
    expect(browserClockCompatible({ ...browserClock, uncertaintyMs: Number.POSITIVE_INFINITY })).toBe(false);
    expect(overlapEvidence({ ...operation, sourceClock: { ...browserClock, upper: 6 } }, samples)).toBeNull();
  });

  it.each(["slow-stdin", "slow-stdout", "slow-http-response"])("does not turn %s into an overlapping pointerup", (delay) => {
    const changed = structuredClone(samples);
    if (delay === "slow-stdin") { changed[0].hostSentAt = 1_000; changed[0].hostReceivedAt = 1_155; }
    if (delay === "slow-stdout") changed[0].hostReceivedAt = 1_160;
    if (delay === "slow-http-response") changed[1].hostSentAt = 1_145;
    expect(causalObservationsValid(changed)).toBe(true);
    expect(overlapEvidence(operation, samples)).not.toBeNull();
    expect(overlapEvidence(operation, changed)).toBeNull();
  });

  it("does not extend the interval to late stdout delivery of the last reply", () => {
    const delayed = [samples[0], { ...samples[1], hostReceivedAt: 1_500 }];
    expect(overlapEvidence(operation, delayed)).toEqual(overlapEvidence(operation, samples));
    expect(overlapEvidence({ ...operation, pointerUpAt: 1_240, pdf: { ...operation.pdf, bodyEndEpochMs: 1_400 } }, delayed)).toBeNull();
  });

  it.each(["idle", "waiting"])("does not bridge a%s gap between two running observations", (gap) => {
    const changed = [samples[0], { ...samples[1], running: gap !== "idle", waiting: gap === "waiting" ? 1 : 0 },
      { ...samples[1], requestId: 4, replyId: 4, sequence: 3, hostSentAt: 1_300, hostReceivedAt: 1_310 }];
    expect(causalObservationsValid(changed)).toBe(true);
    expect(overlapEvidence({ ...operation, pointerUpAt: 1_250, probeEndSequence: 3, pdf: { ...operation.pdf, bodyEndEpochMs: 1_400 } }, changed)).toBeNull();
  });

  it.each(["before-request", "after-body", "different-owner-clock", "idle", "one-sample"])("does not count missing occupancy or own POST evidence: %s", (invalid) => {
    const changedOperation = structuredClone(operation);
    let changedSamples = structuredClone(samples);
    if (invalid === "before-request") changedOperation.pdf.requestStartEpochMs = 1_150;
    if (invalid === "after-body") changedOperation.pdf.bodyEndEpochMs = 1_150;
    if (invalid === "different-owner-clock") changedOperation.pdf.clock = { ...browserClock, lower: 4, upper: 5 };
    if (invalid === "idle") changedSamples[0].running = false;
    if (invalid === "one-sample") changedSamples = changedSamples.slice(0, 1);
    if (invalid === "different-owner-clock") changedOperation.pdf.requestStartEpochMs = 1_147;
    expect(overlapEvidence(changedOperation, changedSamples)).toBeNull();
  });
});

describe("PDF lesson prepared input", () => {
  it("installs the persistent peer observer and completes real down/move before POST, leaving only pointerup for running", async () => {
    const events: string[] = [];
    const element = { style: { transform: "10,20" } };
    const sourceState = { __rimoNetwork: { pointerUpAt: null as number | null } };
    const peerState = { __rimoNetwork: { receivedAt: null as number | null, observer: null as { disconnect(): void } | null } };
    let mutated: (() => void) | undefined;
    vi.stubGlobal("DOMMatrix", class { e = 0; f = 0; constructor(value: string) { [this.e, this.f] = value.split(",").map(Number); } });
    vi.stubGlobal("document", { querySelectorAll: () => [element], elementFromPoint: () => ({ matches: () => true }) });
    vi.stubGlobal("MutationObserver", class {
      constructor(callback: () => void) { mutated = callback; }
      observe(_element: unknown, options: { attributeFilter: string[] }) { expect(options.attributeFilter).toEqual(["style"]); events.push("peer-observer"); }
      disconnect() { events.push("observer-disconnect"); }
    });
    const evaluate = (state: object) => async (callback: (value?: unknown) => unknown, argument?: unknown) => {
      vi.stubGlobal("window", state); return callback(argument);
    };
    const source = { evaluate: evaluate(sourceState), locator: () => ({ boundingBox: async () => ({ x: 0, y: 0 }) }), mouse: {
      move: async (x: number) => { events.push(`move-${x}`); }, down: async () => { events.push("down"); },
      up: async () => { events.push("up"); sourceState.__rimoNetwork.pointerUpAt = hostNow(); element.style.transform = "30,20";
        vi.stubGlobal("window", peerState); mutated?.(); },
    } };
    const peer = { evaluate: evaluate(peerState), waitForFunction: async (callback: () => boolean) => {
      vi.stubGlobal("window", peerState); expect(callback()).toBe(true); events.push("peer-dom");
    } };
    const prepared = await prepareMove(source, peer, { x: 10, y: 20 }, 20);
    expect(events).toEqual(["peer-observer", "move-23", "down", "move-43"]);
    expect(sourceState.__rimoNetwork.pointerUpAt).toBeNull(); expect(peerState.__rimoNetwork.receivedAt).toBeNull();
    events.push("POST", "worker-running");
    await prepared.release();
    expect(events.indexOf("worker-running")).toBeLessThan(events.indexOf("up"));
    expect(events.indexOf("up")).toBeLessThan(events.indexOf("peer-dom"));
    const timing = await prepared.timing();
    expect(timing.pointerUpAt).toBe(sourceState.__rimoNetwork.pointerUpAt);
    expect(timing.receivedAt).toBe(peerState.__rimoNetwork.receivedAt);
    expect(timing.rawPropagationMs).toBeGreaterThanOrEqual(0);
    expect(timing.propagationMs).toBeGreaterThanOrEqual(timing.rawPropagationMs!);
    expect(timing.browserClockEchoes.source).toHaveLength(6); expect(timing.browserClockEchoes.peer).toHaveLength(6);
  });
});
