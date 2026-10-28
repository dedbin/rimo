// @vitest-environment node
import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

import { Y } from "../scripts/performance/common.mjs";
import { acceptanceStatus, actorTargets, cadence, CausalDeliveries, criteria, dueTick, roundTripEvidence, tcClasses,
  trafficEvidence, validateCalibration, validateHelper } from "../scripts/performance/active-room/methodology.mjs";

const labels = Array.from({ length: 8 }, (_, index) => `node-${index}`);
const statistics = (down: number, up: number, cap = "50Mbit") => ({ output: [
  `class htb 1:10 root prio 0 rate ${cap} ceil ${cap} burst 64Kb cburst 64Kb\n Sent ${down} bytes 10 pkt (dropped 0, overlimits 0 requeues 0)`,
  `class htb 1:20 root prio 0 rate ${cap} ceil ${cap} burst 64Kb cburst 64Kb\n Sent ${up} bytes 10 pkt (dropped 0, overlimits 0 requeues 0)`,
].join("\n\n") });

function completeReport() {
  const writers = [...labels, "browser-owner", "browser-editor"].map((label, index) => {
    const kind = index < 8 ? "node" : "browser"; const hz = index < 8 ? 2 : 1;
    return { label, kind, edits: cadence(Array.from({ length: hz * 60 }, (_, step) => step * 1_000 / hz), 0, 60_000, hz),
      presence: cadence(Array.from({ length: 600 }, (_, step) => step * 100), 0, 60_000, 10) };
  });
  const pairs = labels.flatMap((source) => labels.filter((destination) => destination !== source).map((destination) => ({
    source, destination, count: 120, expected: 120, missing: 0, p95: 160,
  })));
  return { seedClosedBeforeMeasurement: true, workload: { minimumConnections: 10, maximumConnections: 10, samples: [{ connections: 10 }, { connections: 10 }], writers,
    browserPropagation: ["browser-owner", "browser-editor"].map((source) => ({ source, count: 60, p95: 160, outsideWindow: 0, undelivered: 0 })),
    causal: { operations: 960, expectedDeliveries: 6720, missingDeliveries: 0, pendingOperations: 0, pairs } },
    paths: writers.map((writer) => ({ label: writer.label, kind: writer.kind, roundtrip: roundTripEvidence([110, 111, 112, 113, 114]),
      connectStatuses: writer.kind === "node" ? [200] : [], upgradeStatuses: writer.kind === "browser" ? [101] : [],
      traffic: trafficEvidence(statistics(1_000, 2_000), statistics(2_000, 4_000)) })),
    finalDrain: { allNodeSnapshotsAcknowledged: true, bothBrowsersSaved: true, browserCoordinatesConverged: true },
    audit: { actorsClosedBeforeAudit: true, allCoordinatesMatch: true, persisted: true },
    clients: writers.map((writer) => ({ label: writer.label, failure: null, pageErrorCount: 0 })), cleanup: [] as { step: string; status: string }[] };
}

describe("mixed active room methodology", () => {
  it("assigns disjoint visible rectangle targets without changing the seed positions", () => {
    const positions = new Map(Array.from({ length: 500 }, (_, index) => [`benchmark_${String(index).padStart(5, "0")}`,
      { x: 220 + index % 25 * 40, y: 220 + Math.floor(index / 25) * 32 }]));
    const before = structuredClone(positions);
    const targets = actorTargets(positions);
    expect(new Set([...targets.nodes, ...targets.browsers].map((entry) => entry.id)).size).toBe(10);
    expect(targets.nodes).toHaveLength(8);
    expect(targets.browsers.map((entry) => entry.x)).toEqual([620, 700]);
    targets.nodes[0].x += 1;
    expect(positions).toEqual(before);
    expect(() => actorTargets(new Map())).toThrow(/target is missing/);
  });

  it("skips missed cadence slots without a catch-up burst or accumulated drift", () => {
    expect(dueTick(500, 499, 500)).toBeNull();
    expect(dueTick(500, 2_400, 500)).toEqual({ next: 2_500, skipped: 3 });
    expect(dueTick(2_500, 2_400, 500)).toBeNull();
  });

  it("exposes an idle writer even when another writer keeps the aggregate edit rate unchanged", () => {
    const normal = cadence(Array.from({ length: 120 }, (_, index) => index * 500), 0, 60_000, 2);
    const idle = cadence([], 0, 60_000, 2);
    const double = cadence(Array.from({ length: 240 }, (_, index) => index * 250), 0, 60_000, 2);
    expect((normal.actualHz * 6 + idle.actualHz + double.actualHz) / 8).toBe(2);
    expect(normal.adequate).toBe(true);
    expect(idle.adequate).toBe(false);
    expect(cadence([0, 500, 6_000], 0, 7_000, 2).maxGapMs).toBe(5_500);
    expect(cadence([0, 500, 60_001], 0, 60_000, 2).outsideWindow).toBe(1);
  });

  it("confirms real Yjs inclusion, including two commits delivered together, only once per receiver", () => {
    const documents = labels.map(() => new Y.Doc());
    const tracker = new CausalDeliveries(labels);
    try {
      documents[0].getMap("layers").set("x", 1);
      const firstClock = Y.decodeStateVector(Y.encodeStateVector(documents[0])).get(documents[0].clientID);
      tracker.sent(labels[0], documents[0].clientID, firstClock, 10);
      documents[1].getMap("other").set("unrelated", 1);
      tracker.observe(labels[1], Y.decodeStateVector(Y.encodeStateVector(documents[1])), 20);
      expect(tracker.summary().missingDeliveries).toBe(7);
      documents[0].getMap("layers").set("x", 2);
      const endClock = Y.decodeStateVector(Y.encodeStateVector(documents[0])).get(documents[0].clientID);
      tracker.sent(labels[0], documents[0].clientID, endClock, 30);
      for (let index = 1; index < 8; index += 1) {
        Y.applyUpdate(documents[index], Y.encodeStateAsUpdate(documents[0]));
        const vector = Y.decodeStateVector(Y.encodeStateVector(documents[index]));
        tracker.observe(labels[index], vector, 100);
        tracker.observe(labels[index], vector, 200);
      }
      const summary = tracker.summary();
      expect(summary.propagationMs).toMatchObject({ count: 14, p50: 70, p95: 90, max: 90 });
      expect(summary.missingDeliveries).toBe(0);
      expect(summary.pendingOperations).toBe(0);
      expect(summary.pairs.filter((pair) => pair.source === labels[0]).every((pair) => pair.count === 2)).toBe(true);
    } finally { documents.forEach((document) => document.destroy()); }
  });

  it("retains missing and late operations rather than expiring them into a faster p95", () => {
    const tracker = new CausalDeliveries(labels);
    tracker.sent(labels[0], 123, 5, 10);
    tracker.observe(labels[1], new Map([[123, 4]]), 120_000);
    expect(tracker.summary()).toMatchObject({ pendingOperations: 1, missingDeliveries: 7 });
    tracker.observe(labels[1], new Map([[123, 5]]), 120_010);
    expect(tracker.summary()).toMatchObject({ pendingOperations: 1, missingDeliveries: 6, propagationMs: { max: 120_000 } });
  });

  it("requires current calibration, both 50 Mbit classes, and growing counters in both directions", () => {
    const metadata = { image: "immutable-image", helperConfigurationSha256: "config", perDirectionBitsPerSecond: 50_000_000 };
    const calibration = { status: "complete", networkSourceSha256: "current", checks: { http: true, ws: true, download: true, upload: true }, helper: metadata };
    expect(() => validateCalibration(calibration, "current")).not.toThrow();
    expect(() => validateCalibration(calibration, "changed")).toThrow(/calibration/);
    expect(() => validateHelper({ ...metadata, image: "new-image" }, calibration)).toThrow(/differs/);
    expect(tcClasses(statistics(1, 2))["1:10"].rate).toBe(50_000_000);
    expect(() => tcClasses(statistics(1, 2, "100Mbit"))).toThrow(/50 Mbit/);
    expect(() => trafficEvidence(statistics(10, 20), statistics(11, 20))).toThrow(/grow/);
    expect(() => trafficEvidence(statistics(10, 20), statistics(9, 21))).toThrow(/grow/);
    expect(() => tcClasses({ output: statistics(1, 2).output.replace("1:20", "1:10") })).toThrow(/Duplicate/);
    expect(() => roundTripEvidence([1, 2, 3, 4, 5])).toThrow(/RTT/);
    expect(() => roundTripEvidence([100, 100, 100, 100, Number.NaN])).toThrow(/RTT/);
  });

  it("accepts only the complete mixed profile without mutating its evidence", () => {
    const report = completeReport(); const before = structuredClone(report);
    expect(acceptanceStatus(report)).toBe("accepted");
    expect(report).toEqual(before);
    expect(Object.values(criteria({ cleanup: [] })).some(Boolean)).toBe(false);
  });

  it.each(["seed", "traffic", "connect", "upgrade", "connection", "writer", "presence", "browser-p95", "browser-undelivered", "node-p95", "causal-count", "missing", "audit", "ack", "saved", "page-error"])(
    "does not accept incomplete %s evidence", (missing) => {
      const report = completeReport();
      if (missing === "seed") report.seedClosedBeforeMeasurement = false;
      if (missing === "traffic") report.paths[0].traffic[0].deltaBytes = 0;
      if (missing === "connect") report.paths[0].connectStatuses = [];
      if (missing === "upgrade") report.paths[8].upgradeStatuses = [];
      if (missing === "connection") report.workload.minimumConnections = 9;
      if (missing === "writer") report.workload.writers[0].edits = cadence([], 0, 60_000, 2);
      if (missing === "presence") report.workload.writers[0].presence.adequate = false;
      if (missing === "browser-p95") report.workload.browserPropagation[1].p95 = 301;
      if (missing === "browser-undelivered") report.workload.browserPropagation[1].undelivered = 1;
      if (missing === "node-p95") report.workload.causal.pairs[0].p95 = 301;
      if (missing === "causal-count") report.workload.causal.operations = 959;
      if (missing === "missing") report.workload.causal.missingDeliveries = 1;
      if (missing === "audit") report.audit.actorsClosedBeforeAudit = false;
      if (missing === "ack") report.finalDrain.allNodeSnapshotsAcknowledged = false;
      if (missing === "saved") report.finalDrain.bothBrowsersSaved = false;
      if (missing === "page-error") report.clients[8].pageErrorCount = 1;
      expect(acceptanceStatus(report)).toBe("not-accepted");
    });

  it("cannot turn an interruption or failed cleanup into acceptance", () => {
    expect(acceptanceStatus({ ...completeReport(), error: "first failure" })).toBe("not-accepted");
    expect(acceptanceStatus({ ...completeReport(), interruption: { reason: "SIGTERM" } })).toBe("interrupted");
    const report = completeReport(); report.cleanup.push({ step: "owned helper", status: "failed" });
    expect(acceptanceStatus(report)).toBe("cleanup-failed");
  });

  it("prints help and rejects a missing opt-in before reading credentials or touching the service", async () => {
    const execute = promisify(execFile);
    const script = path.resolve("scripts/performance/active-room/run.mjs");
    const help = await execute(process.execPath, ["--import=tsx", script, "--help"], { windowsHide: true, timeout: 10_000 });
    expect(help.stdout).toContain("--allow-service-test");
    await expect(execute(process.execPath, ["--import=tsx", script, "--storage-state", "missing-private-fixture.json"],
      { windowsHide: true, timeout: 10_000 })).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining("explicit --allow-service-test") });
  });
});
