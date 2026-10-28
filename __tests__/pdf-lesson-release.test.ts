// @vitest-environment node
import { describe, expect, it } from "vitest";

import { consecutiveBusyPair } from "../scripts/performance/pdf-lesson/causal.mjs";

function sample(sequence: number, overrides: Partial<{
  requestId: number; replyId: number; running: boolean; ok: boolean; waiting: number;
}> = {}) {
  return { sequence, requestId: sequence, replyId: sequence, hostSentAt: sequence * 30,
    hostReceivedAt: sequence * 30 + 2, ok: true, running: true, waiting: 0, ...overrides };
}

describe("PDF lesson release after consecutive busy observations", () => {
  it("requires two correlated replies and preserves both sequence and host bounds", () => {
    const first = sample(1); const second = sample(2);
    expect(consecutiveBusyPair([], 0)).toBeNull();
    expect(consecutiveBusyPair([first], 0)).toBeNull();
    expect(consecutiveBusyPair([first, second], 0)).toEqual([first, second]);
    expect(consecutiveBusyPair([first, second], 0)?.map((entry: ReturnType<typeof sample>) => [entry.sequence, entry.hostSentAt, entry.hostReceivedAt]))
      .toEqual([[1, 30, 32], [2, 60, 62]]);
  });

  it("does not use a pair before or straddling the operation start", () => {
    const observations = [sample(1), sample(2)];
    expect(consecutiveBusyPair(observations, 2)).toBeNull();
    expect(consecutiveBusyPair(observations, 1)).toBeNull();
    expect(consecutiveBusyPair([...observations, sample(3)], 1)).toEqual([sample(2), sample(3)]);
  });

  it.each(["sequence-gap", "reply-id", "request-order"])("rejects invalid correlation: %s", (invalid) => {
    const observations = [sample(1), sample(2)];
    if (invalid === "sequence-gap") observations[1].sequence = 3;
    if (invalid === "reply-id") observations[1].replyId = 99;
    if (invalid === "request-order") observations[1].requestId = observations[1].replyId = 1;
    expect(consecutiveBusyPair(observations, 0)).toBeNull();
  });

  it.each(["idle", "error", "waiting"])("does not bridge a %s observation", (gap) => {
    const middle = sample(2, { running: gap !== "idle", ok: gap !== "error", waiting: gap === "waiting" ? 1 : 0 });
    const observations = [sample(1), middle, sample(3)];
    expect(consecutiveBusyPair(observations, 0)).toBeNull();
    expect(consecutiveBusyPair([...observations, sample(4)], 0)).toEqual([sample(3), sample(4)]);
  });

  it("does not trigger from an earlier pair after a newer idle reply", () => {
    expect(consecutiveBusyPair([sample(1), sample(2), sample(3, { running: false })], 0)).toBeNull();
  });

  it.each([-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY])("rejects invalid start sequence %s", (after) => {
    expect(consecutiveBusyPair([sample(1), sample(2)], after)).toBeNull();
  });
});
