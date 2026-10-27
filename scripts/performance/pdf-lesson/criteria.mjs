import { causalObservationsValid } from "./causal.mjs";
import { browserClockCompatible } from "./clock.mjs";

/** Conservative occupancy evidence; this does not identify Chromium CPU phases. */
export function overlapEvidence(operation, samples) {
  if (!causalObservationsValid(samples) || !Number.isFinite(operation.pointerUpAt) || !browserClockCompatible(operation.sourceClock) ||
      !browserClockCompatible(operation.pdf?.clock) || !Number.isSafeInteger(operation.probeStartSequence) ||
      !Number.isSafeInteger(operation.probeEndSequence) || operation.probeEndSequence <= operation.probeStartSequence ||
      ![operation.pdf.requestStartEpochMs, operation.pdf.bodyEndEpochMs].every(Number.isFinite)) return null;
  const pointerFrom = operation.pointerUpAt + operation.sourceClock.lower;
  const pointerTo = operation.pointerUpAt + operation.sourceClock.upper;
  if (pointerFrom < operation.pdf.requestStartEpochMs + operation.pdf.clock.upper ||
      pointerTo > operation.pdf.bodyEndEpochMs + operation.pdf.clock.lower) return null;
  let start;
  for (const sample of samples) {
    if (sample.sequence <= operation.probeStartSequence || sample.sequence > operation.probeEndSequence) continue;
    if (!sample.ok || !sample.running || sample.waiting !== 0) { start = undefined; continue; }
    start ??= sample;
    const from = start.hostReceivedAt + 2;
    const to = sample.hostSentAt - 2;
    if (Number.isFinite(from) && Number.isFinite(to) && from <= pointerFrom && pointerTo <= to) {
      return { fromEpochMs: from, toEpochMs: to, firstSequence: start.sequence, lastSequence: sample.sequence,
        firstReplyId: start.replyId, lastRequestId: sample.requestId,
        pointerUpAt: operation.pointerUpAt, pointerHostBounds: { lower: pointerFrom, upper: pointerTo },
        meaning: "worker queue occupied, not Chromium CPU timing" };
    }
  }
  return null;
}

export function criteria(report) {
  const count = report.operations.length;
  const overlap = report.operations.filter((entry) => entry.overlap !== null);
  return {
    declaredExportsCompleted: Number.isSafeInteger(report.requestedExports) && report.requestedExports >= 20 && count === report.requestedExports,
    allExportsHaveTwentyVerifiedPages: count > 0 && report.operations.every((entry) => entry.pdf?.verified?.pages === 20 &&
      entry.pdf.verified.russian_text_searchable && entry.pdf.verified.russian_text_copyable && entry.pdf.verified.page_order_verified &&
      entry.pdf.verified.independent_pdfminer_exact_phrases),
    allExportsWithin30Seconds: count > 0 && report.operations.every((entry) => Number.isFinite(entry.pdf?.requestDurationMs) &&
      entry.pdf.requestDurationMs >= 0 && entry.pdf.requestDurationMs <= 30_000),
    fixedRevisionThroughout: Number.isSafeInteger(report.snapshot?.revision) && count > 0 && report.operations.every((entry) => entry.pdf?.revision === report.snapshot.revision),
    bothEditorsParticipated: report.operations.filter((entry) => entry.source === "owner").length >= 10 && report.operations.filter((entry) => entry.source === "editor").length >= 10,
    atLeastTwentyOverlappingFinalOperations: overlap.length >= 20,
    fullPropagationP95Within300ms: report.fullPropagation?.count === count && count > 0 && report.fullPropagation.p95 <= 300,
    overlapPropagationP95Within300ms: report.overlapPropagation?.count === overlap.length && overlap.length >= 20 && report.overlapPropagation.p95 <= 300,
    measuredRoundtripNear100ms: report.roundtrip?.count >= 20 && report.roundtrip.p50 >= 90 && report.roundtrip.p50 <= 200,
    calibrated50Mbit: report.calibration?.status === "complete" && Object.values(report.calibration.checks ?? {}).length >= 4 &&
      Object.values(report.calibration.checks).every((entry) => entry === true) && report.helpers.length === 2 &&
      report.helpers.every((entry) => entry.perDirectionBitsPerSecond === 50_000_000 && entry.image === report.calibration.helper?.image &&
        entry.helperConfigurationSha256 === report.calibration.helper?.helperConfigurationSha256),
    causalProbeObservationsValid: causalObservationsValid(report.probe?.samples),
    browserMonotonicEpochClocksCompatible: count > 0 && report.operations.every((entry) => browserClockCompatible(entry.sourceClock) &&
      browserClockCompatible(entry.peerClock) && browserClockCompatible(entry.pdf?.clock)),
    probeHealthyAndQueueUncontended: report.probe?.samples?.length > 0 && report.probe.samples.every((entry) => entry.ok && entry.waiting === 0),
    everyMoveSavedAndUndone: count > 0 && report.operations.every((entry) => entry.saved === true && entry.undoRestored === true),
    finalStateDurable: report.durable?.originalCoordinatesRestored === true && report.durable?.controlContentRestored === true && report.durable?.persisted === true,
    noPageErrors: report.pageErrors.length === 0,
    workerMemoryRecorded: [report.memoryBefore, report.memoryImmediateAfter, report.memoryAfterFiveSecondIdle].every((entry) =>
      entry?.cgroupCurrentBytes > 0 && entry.cgroupLimitBytes > 0 && entry.cgroupCurrentBytes <= entry.cgroupLimitBytes && entry.pid1RssBytes > 0),
    noRuntimeFailure: report.error === undefined,
    noInterruption: report.interruption === undefined,
  };
}

export function acceptanceStatus(checks, cleanup) {
  if (cleanup.some((entry) => entry.status !== "complete")) return "cleanup-failed";
  return Object.keys(checks).length > 0 && Object.values(checks).every((entry) => entry === true) ? "accepted" : "not-accepted";
}
