import { distribution, fail } from "../common.mjs";

const NODE_INDICES = Object.freeze([0, 10, 20, 30, 40, 50, 60, 70]);
const BROWSER_INDICES = Object.freeze([210, 212]);

export function actorTargets(positions) {
  const target = (index) => {
    const id = `benchmark_${String(index).padStart(5, "0")}`;
    const position = positions.get(id);
    if (!position) throw fail("Active-room fixture target is missing");
    return { id, ...position };
  };
  return { nodes: NODE_INDICES.map(target), browsers: BROWSER_INDICES.map(target) };
}

export function dueTick(next, now, interval) {
  if (now < next) return null;
  const skipped = Math.floor((now - next) / interval);
  return { next: next + (skipped + 1) * interval, skipped };
}

export function cadence(timestamps, start, end, hz, skipped = 0) {
  const times = timestamps.toSorted((a, b) => a - b);
  const gaps = times.map((time, index) => time - (index ? times[index - 1] : start));
  gaps.push(end - (times.at(-1) ?? start));
  const expected = Math.floor((end - start) / 1_000 * hz);
  return { count: times.length, expected, targetHz: hz, actualHz: times.length * 1_000 / (end - start), skippedTicks: skipped,
    maxGapMs: Math.max(...gaps), gapMs: distribution(gaps),
    outsideWindow: times.filter((time) => !Number.isFinite(time) || time < start || time > end).length,
    adequate: times.length >= Math.floor(expected * 0.95) && skipped <= Math.ceil(expected * 0.05) &&
      gaps.every((gap) => Number.isFinite(gap) && gap >= 0 && gap <= 3_000 / hz) && times.every((time) => time >= start && time <= end) };
}

export function validateCalibration(calibration, networkHash) {
  if (calibration.status !== "complete" || Object.keys(calibration.checks ?? {}).length < 4 ||
      !Object.values(calibration.checks).every((value) => value === true) || calibration.networkSourceSha256 !== networkHash) {
    throw fail("Run a successful calibration of the current network helper sources first");
  }
}

export function validateHelper(metadata, calibration) {
  if (metadata.image !== calibration.helper?.image ||
      metadata.helperConfigurationSha256 !== calibration.helper?.helperConfigurationSha256 ||
      metadata.perDirectionBitsPerSecond !== 50_000_000) throw fail("Network helper differs from the successful calibration");
}

export function roundTripEvidence(values) {
  if (values.length !== 5 || values.some((value) => !Number.isFinite(value) || value < 90)) {
    throw fail("Each active-room path needs five real WebSocket RTT samples of at least 90 ms");
  }
  return { samplesMs: [...values], ...distribution(values) };
}

export function tcClasses(statistics) {
  /** @type {Record<string, {rate: number, ceiling: number, sentBytes: number}>} */
  const classes = {};
  const pattern = /^class htb (1:(?:10|20))\s[^\r\n]*\brate (\S+) ceil (\S+)[^\r\n]*\r?\n\s*Sent (\d+) bytes/gm;
  const bits = (value) => {
    const match = /^(\d+(?:\.\d+)?)([KMGT]?)bit$/.exec(value);
    return match ? Number(match[1]) * 1_000 ** ["", "K", "M", "G", "T"].indexOf(match[2]) : NaN;
  };
  for (const [, id, rate, ceiling, sent] of statistics.output.matchAll(pattern)) {
    if (Object.hasOwn(classes, id)) throw fail("Duplicate HTB traffic class");
    classes[id] = { rate: bits(rate), ceiling: bits(ceiling), sentBytes: Number(sent) };
  }
  if (Object.keys(classes).length !== 2 || Object.values(classes).some((entry) =>
    entry.rate !== 50_000_000 || entry.ceiling !== 50_000_000 || !Number.isSafeInteger(entry.sentBytes))) {
    throw fail("Both helper HTB classes must have a real 50 Mbit/s rate and ceiling");
  }
  return classes;
}

export function trafficEvidence(before, after) {
  const initial = tcClasses(before); const final = tcClasses(after);
  return Object.entries(final).map(([id, entry]) => {
    const deltaBytes = entry.sentBytes - initial[id].sentBytes;
    if (deltaBytes <= 0) throw fail("Both helper HTB counters must grow during the active window");
    return { classId: id, ...entry, initialBytes: initial[id].sentBytes, deltaBytes };
  });
}

/** A receiver must include the sender's Yjs clock, not merely emit an update. */
export class CausalDeliveries {
  constructor(labels) {
    if (labels.length !== 8 || new Set(labels).size !== 8) throw fail("Causal timing requires eight distinct Node providers");
    this.labels = [...labels]; this.pending = new Map(); this.pairs = new Map();
    this.operations = 0; this.highestPending = 0;
    for (const source of labels) for (const destination of labels) if (source !== destination) {
      this.pairs.set(`${source}:${destination}`, { source, destination, expected: 0, values: [] });
    }
  }

  sent(source, clientId, endClock, start) {
    if (!this.labels.includes(source) || !Number.isSafeInteger(clientId) || clientId < 0 || !Number.isSafeInteger(endClock) || endClock < 1 || !Number.isFinite(start)) {
      throw fail("Invalid causal operation clock");
    }
    const remaining = new Set(this.labels.filter((label) => label !== source));
    this.pending.set(++this.operations, { source, clientId, endClock, start, remaining });
    for (const destination of remaining) this.pairs.get(`${source}:${destination}`).expected += 1;
    this.highestPending = Math.max(this.highestPending, this.pending.size);
    if (this.pending.size > 10_000) throw fail("Causal pending-operation limit reached");
  }

  observe(destination, vector, now) {
    for (const [id, entry] of this.pending) {
      if (!entry.remaining.has(destination) || (vector.get(entry.clientId) ?? 0) < entry.endClock) continue;
      if (!Number.isFinite(now) || now < entry.start) throw fail("Invalid causal measurement clock ordering");
      this.pairs.get(`${entry.source}:${destination}`).values.push(now - entry.start);
      entry.remaining.delete(destination);
      if (!entry.remaining.size) this.pending.delete(id);
    }
  }

  summary() {
    const pairs = [...this.pairs.values()].map((entry) => ({ source: entry.source, destination: entry.destination,
      expected: entry.expected, missing: entry.expected - entry.values.length, ...distribution(entry.values) }));
    return { operations: this.operations, expectedDeliveries: this.operations * 7,
      pendingOperations: this.pending.size, missingDeliveries: pairs.reduce((sum, pair) => sum + pair.missing, 0),
      highestPendingOperations: this.highestPending, propagationMs: distribution([...this.pairs.values()].flatMap((pair) => pair.values)), pairs };
  }
}

export function criteria(report) {
  const workload = report.workload;
  const browsers = workload?.browserPropagation ?? [];
  const actors = workload?.writers ?? [];
  const nodeWriters = actors.filter((actor) => actor.kind === "node");
  const paths = report.paths ?? [];
  return {
    tenConnectionsThroughoutWindow: report.seedClosedBeforeMeasurement === true && workload?.minimumConnections === 10 && workload?.maximumConnections === 10 && workload?.samples?.length > 1,
    everyWriterMaintainedCadence: actors.length === 10 && new Set(actors.map((actor) => actor.label)).size === 10 && actors.every((actor) => actor.edits.adequate) &&
      nodeWriters.length === 8 && nodeWriters.every((actor) => actor.presence.adequate),
    browserFinalDomP95Within300ms: browsers.length === 2 && browsers.every((entry) => entry.count >= 50 && Number.isFinite(entry.p95) && entry.p95 <= 300 &&
      entry.count === actors.find((actor) => actor.label === entry.source)?.edits.count && entry.outsideWindow === 0 && entry.undelivered === 0),
    nodeCausalP95Within300ms: workload?.causal?.pairs?.length === 56 && workload.causal.pairs.every((entry) => entry.count > 0 && entry.missing === 0 &&
      entry.count === nodeWriters.find((actor) => actor.label === entry.source)?.edits.count && Number.isFinite(entry.p95) && entry.p95 <= 300),
    allCausalOperationsDelivered: workload?.causal?.operations > 0 && workload.causal.missingDeliveries === 0 && workload.causal.pendingOperations === 0 &&
      workload.causal.operations === nodeWriters.reduce((sum, writer) => sum + writer.edits.count, 0) && workload.causal.expectedDeliveries === workload.causal.operations * 7,
    tenCalibratedPathsWithMeasuredTraffic: paths.length === 10 && paths.every((entry) => entry.roundtrip?.count === 5 && entry.roundtrip.samplesMs.every((value) => value >= 90) &&
      entry.traffic?.length === 2 && entry.traffic.every((item) => item.deltaBytes > 0 && item.rate === 50_000_000 && item.ceiling === 50_000_000)),
    nodeConnectAndBrowserUpgradeConfirmed: paths.length === 10 && paths.every((entry) => entry.kind === "node" ? entry.connectStatuses?.length === 1 && entry.connectStatuses[0] === 200
      : entry.upgradeStatuses?.length === 1 && entry.upgradeStatuses[0] === 101),
    savedOnlyAfterAllWritersStopped: report.finalDrain?.allNodeSnapshotsAcknowledged === true && report.finalDrain?.bothBrowsersSaved === true && report.finalDrain?.browserCoordinatesConverged === true,
    freshDurableAuditAfterTenActorsClosed: report.audit?.actorsClosedBeforeAudit === true && report.audit?.allCoordinatesMatch === true && report.audit?.persisted === true,
    noRuntimeErrors: !report.error && !workload?.error && (report.clients?.length ?? 0) === 10 && report.clients.every((client) => !client.failure && !client.pageErrorCount),
  };
}

export function acceptanceStatus(report) {
  if (report.cleanup.some((step) => step.status !== "complete")) return "cleanup-failed";
  if (report.interruption) return "interrupted";
  return Object.values(criteria(report)).every(Boolean) ? "accepted" : "not-accepted";
}
