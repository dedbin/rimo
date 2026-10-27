function validSample(entry, previous) {
  return Number.isSafeInteger(entry.requestId) && entry.requestId > 0 && entry.replyId === entry.requestId &&
    Number.isSafeInteger(entry.sequence) && entry.sequence === (previous?.sequence ?? 0) + 1 &&
    [entry.hostSentAt, entry.hostReceivedAt].every(Number.isFinite) && entry.hostSentAt >= 0 && entry.hostReceivedAt >= entry.hostSentAt &&
    (!previous || entry.requestId > previous.requestId && entry.hostSentAt >= previous.hostReceivedAt) &&
    typeof entry.ok === "boolean" && typeof entry.running === "boolean" && Number.isInteger(entry.waiting) && entry.waiting >= 0 && entry.waiting <= 2;
}

/** All accepted bounds originate in the runner, not timestamps supplied by the remote process. */
export function healthRecord(reply, request, previous, hostReceivedAt) {
  if (request?.kind !== "health" || reply?.kind !== "health") throw new Error("Unexpected worker probe reply kind");
  const diagnostic = (value) => Number.isFinite(value) ? value : null;
  const entry = { requestId: request.id, replyId: reply.id, sequence: reply.sequence,
    hostSentAt: request.hostSentAt, hostReceivedAt, ok: reply.ok, running: reply.running, waiting: reply.waiting,
    hostSentWallEpochMs: request.hostSentWallEpochMs, hostReceivedWallEpochMs: Date.now(),
    remoteAtEpochMs: diagnostic(reply.atEpochMs), remoteStartedMonotonicMs: diagnostic(reply.startedMonotonicMs),
    remoteMonotonicMs: diagnostic(reply.monotonicMs) };
  if (!validSample(entry, previous)) throw new Error("Invalid correlated worker health observation");
  return entry;
}

export function causalObservationsValid(samples) {
  return Array.isArray(samples) && samples.length > 1 && samples.every((entry, index) => validSample(entry, samples[index - 1]));
}
