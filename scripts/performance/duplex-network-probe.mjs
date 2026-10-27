import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import { HttpsProxyAgent } from "https-proxy-agent";
import WebSocket, { WebSocketServer } from "ws";

import { cleanupStep, networkSourceHash, startHelper, writeNetworkReport } from "./network/helper.mjs";
import { createRunLifecycle } from "./network/lifecycle.mjs";

// Diagnostic only: no Rimo API, Yjs, ACL, persistence, or service acceptance gate.
const COUNT = 8; const SECONDS = 30; const LENGTHS = [280, 80]; const INTERVALS = [100, 500];
const MAGIC = 0x44555031; const MAX_OPERATIONS = COUNT * SECONDS * 12;
const runId = randomUUID();
const reportFile = fileURLToPath(new URL(`../../temp/performance/duplex-network/${runId}.json`, import.meta.url));
const report = { kind: "inert-duplex-network-diagnostic", runId, at: new Date().toISOString(), status: "running", measurementValid: false,
  methodology: { participants: COUNT, phaseSeconds: SECONDS, latencyMsPerDirection: [0, 50], bitsPerSecondPerDirection: 50_000_000,
    frames: "binary awareness 280B at 10Hz, then update 80B at 2Hz; synchronous eight-writer waves; every frame echoed and fanned to all eight",
    clock: "one Node process performance.now(); send-call, server message event, server send-call, client message event",
    scope: "inert transport diagnostic; no 300ms acceptance decision and no production-fix claim" },
  helperAttempts: [], helpers: [], phases: [], cleanup: [] };
const helpers = []; const actors = []; let active; let listening = false; let reportOwned = false;
const server = createServer((_request, response) => response.writeHead(404).end());
const websocket = new WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload: Math.max(...LENGTHS) });
const stopSockets = () => { for (const actor of actors) actor.close(); for (const peer of websocket.clients) peer.terminate(); };
const lifecycle = createRunLifecycle(300_000, stopSockets);
const save = () => writeNetworkReport(reportFile, report);
const sleep = (milliseconds) => delay(milliseconds, undefined, { signal: lifecycle.signal });
const key = (source, kind, sequence) => `${source}:${kind}:${sequence}`;
const summary = (values) => {
  const sorted = values.toSorted((a, b) => a - b);
  const at = (fraction) => sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)] ?? null;
  return { count: sorted.length, p50: at(0.5), p95: at(0.95), max: sorted.at(-1) ?? null };
};
const check = (state) => {
  lifecycle.check(); if (state.failure) throw state.failure;
  assert.equal(state.peers.size, COUNT, "All eight inert server peers must remain connected");
  assert.ok(state.actors.every((actor) => actor.socket.readyState === WebSocket.OPEN), "Inert client disconnected");
};
const failure = (state, error) => { if (!state.closing) state.failure ??= error instanceof Error ? error : new Error("Inert socket failure"); };

server.on("upgrade", (request, socket, head) => {
  // A reset can arrive before ws installs its socket error handler, including on a rejected upgrade.
  socket.on("error", () => socket.destroy());
  const state = active; const match = new RegExp(`^/duplex/${runId}/([12])/([0-7])$`).exec(request.url ?? "");
  if (!state || state.closing || !match || Number(match[1]) !== state.id || state.peers.has(Number(match[2]))) {
    socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n"); return;
  }
  const source = Number(match[2]);
  websocket.handleUpgrade(request, socket, head, (peer) => {
    state.peers.set(source, peer);
    peer.on("error", (error) => failure(state, error));
    peer.on("close", () => { state.peers.delete(source); failure(state, new Error("Inert server peer closed")); });
    peer.on("message", (data, binary) => {
      const received = performance.now();
      try {
        assert.ok(binary && data.length >= 36 && data.readUInt32LE(0) === MAGIC, "Invalid inert frame header");
        const kind = data[5]; const sequence = data.readUInt32LE(8);
        assert.ok(data[4] === state.id && data[6] === source && data[7] === 255 && data.length === LENGTHS[kind], "Invalid inert frame identity");
        const operation = state.operations.get(key(source, kind, sequence));
        assert.ok(operation && data.readDoubleLE(12) === operation.sent, "Uncorrelated inert server frame");
        if (operation.serverReceived !== null) { state.serverDuplicates += 1; return; }
        operation.serverReceived = received; state.serverFrames += 1;
        for (const [destination, target] of state.peers) {
          const outgoing = Buffer.from(data); const sent = performance.now();
          outgoing[7] = destination; outgoing.writeDoubleLE(received, 20); outgoing.writeDoubleLE(sent, 28);
          operation.serverSent[destination] = sent;
          target.send(outgoing, (error) => { if (error) failure(state, error); });
        }
      } catch (error) { failure(state, error); }
    });
  });
});
websocket.on("error", (error) => { if (active) failure(active, error); });

async function connectActor(state, index) {
  const agent = new HttpsProxyAgent(helpers[index].proxy.server);
  const statuses = []; agent.on("proxyConnect", ({ statusCode }) => statuses.push(statusCode));
  const socket = new WebSocket(`ws://localhost:18991/duplex/${runId}/${state.id}/${index}`, { agent, perMessageDeflate: false, handshakeTimeout: 15_000 });
  const actor = { socket, statuses, closed: false, close() { if (this.closed) return; this.closed = true; socket.terminate(); agent.destroy(); } };
  actors.push(actor); state.actors.push(actor);
  socket.on("error", (error) => { if (!actor.closed) failure(state, error); });
  socket.on("close", () => { if (!actor.closed) failure(state, new Error("Inert client closed")); });
  socket.on("message", (data, binary) => {
    const received = performance.now();
    try {
      assert.ok(++state.clientFrames <= MAX_OPERATIONS * COUNT * 2, "Inert received-frame bound exceeded");
      assert.ok(binary && data.length >= 36 && data.readUInt32LE(0) === MAGIC, "Invalid inert delivery header");
      const source = data[6]; const kind = data[5]; const sequence = data.readUInt32LE(8);
      assert.ok(data[4] === state.id && source < COUNT && data[7] === index && data.length === LENGTHS[kind], "Invalid inert delivery identity");
      const operation = state.operations.get(key(source, kind, sequence));
      const serverReceived = data.readDoubleLE(20); const serverSent = data.readDoubleLE(28);
      assert.ok(operation && operation.sent === data.readDoubleLE(12) && operation.serverReceived === serverReceived &&
        operation.serverSent[index] === serverSent && operation.sent <= serverReceived && serverReceived <= serverSent && serverSent <= received,
      "Invalid inert delivery correlation or timing");
      const pair = state.pairs[kind][source * COUNT + index];
      if (operation.receivers & (1 << index)) { pair.duplicates += 1; return; }
      operation.receivers |= 1 << index; state.deliveries += 1;
      pair.endToEnd.push(received - operation.sent); pair.uplink.push(serverReceived - operation.sent);
      pair.relay.push(serverSent - serverReceived); pair.downlink.push(received - serverSent);
    } catch (error) { failure(state, error); }
  });
  await new Promise((resolve, reject) => {
    const finish = (error) => { socket.off("open", opened); socket.off("error", errored); socket.off("close", closed); if (error) reject(error); else resolve(); };
    const opened = () => finish(); const errored = (error) => finish(error); const closed = () => finish(new Error("Inert client closed before open"));
    socket.once("open", opened); socket.once("error", errored); socket.once("close", closed);
  });
  assert.deepEqual(statuses, [200], "Each inert client must have exactly one CONNECT 200");
}

function send(state, source, kind) {
  assert.ok(state.operations.size < MAX_OPERATIONS, "Inert operation bound exceeded");
  const writer = state.writers[source]; const sequence = ++writer.counts[kind]; const sent = performance.now();
  const frame = Buffer.alloc(LENGTHS[kind]); frame.writeUInt32LE(MAGIC, 0);
  frame[4] = state.id; frame[5] = kind; frame[6] = source; frame[7] = 255;
  frame.writeUInt32LE(sequence, 8); frame.writeDoubleLE(sent, 12);
  state.operations.set(key(source, kind, sequence), { sent, serverReceived: null, serverSent: Array(COUNT).fill(null), receivers: 0 });
  writer.times[kind].push(sent);
  state.actors[source].socket.send(frame, (error) => { if (error) failure(state, error); });
}

async function measurePhase(id, latency) {
  const state = { id, peers: new Map(), actors: [], operations: new Map(), failure: null, closing: false,
    serverDuplicates: 0, serverFrames: 0, clientFrames: 0, deliveries: 0,
    writers: Array.from({ length: COUNT }, () => ({ counts: [0, 0], skipped: [0, 0], times: [[], []] })),
    pairs: LENGTHS.map(() => Array.from({ length: COUNT * COUNT }, () => ({ endToEnd: [], uplink: [], relay: [], downlink: [], duplicates: 0 }))) };
  active = state; const eventLoop = monitorEventLoopDelay({ resolution: 10 });
  const phase = { id, latencyMsPerDirection: latency, status: "running" }; report.phases.push(phase);
  try {
    const configured = await Promise.allSettled(helpers.map((helper) => helper.configure([18991], latency)));
    const rejected = configured.find((result) => result.status === "rejected"); if (rejected) throw rejected.reason;
    lifecycle.check();
    // Opening order preserves the source index used by the synchronous generator.
    for (let index = 0; index < COUNT; index += 1) { lifecycle.check(); await connectActor(state, index); }
    check(state); const started = performance.now() + 100; const end = started + SECONDS * 1_000;
    phase.windowStartedMs = started; phase.windowEndedMs = end;
    const deadlines = state.writers.map(() => [started, started]); eventLoop.enable();
    while (performance.now() < end) {
      check(state); const now = performance.now();
      if (now < started) { await sleep(10); continue; }
      for (let source = 0; source < COUNT; source += 1) for (let kind = 0; kind < LENGTHS.length; kind += 1) {
        if (now < deadlines[source][kind]) continue;
        const skipped = Math.floor((now - deadlines[source][kind]) / INTERVALS[kind]);
        deadlines[source][kind] += (skipped + 1) * INTERVALS[kind]; state.writers[source].skipped[kind] += skipped;
        send(state, source, kind);
      }
      await sleep(10);
    }
    phase.generator = { eventLoopP95Ms: eventLoop.percentile(95) / 1e6, eventLoopMaxMs: eventLoop.max / 1e6,
      rssBytes: process.memoryUsage().rss, heapUsedBytes: process.memoryUsage().heapUsed }; eventLoop.disable();
    const drainStarted = performance.now();
    while (state.deliveries < state.operations.size * COUNT && performance.now() - drainStarted < 10_000) { check(state); await sleep(10); }
    check(state); phase.drainMs = performance.now() - drainStarted; phase.status = "complete";
  } catch (error) { phase.status = "failed"; throw error; }
  finally {
    eventLoop.disable(); state.closing = true;
    phase.connections = state.actors.map((actor, index) => ({ index, connectStatuses: actor.statuses }));
    phase.writers = state.writers.map((writer, index) => ({ index, frames: LENGTHS.map((bytes, kind) => ({
      kind: kind ? "update" : "awareness", bytes, count: writer.counts[kind], expected: SECONDS * 1_000 / INTERVALS[kind], skippedTicks: writer.skipped[kind],
      outsideWindow: writer.times[kind].filter((time) => time < phase.windowStartedMs || time > phase.windowEndedMs).length,
      gapsMs: summary(writer.times[kind].slice(1).map((time, i) => time - writer.times[kind][i])) })) }));
    phase.pairs = state.pairs.flatMap((pairs, kind) => pairs.map((pair, index) => ({ kind: kind ? "update" : "awareness",
      source: Math.floor(index / COUNT), destination: index % COUNT, echo: Math.floor(index / COUNT) === index % COUNT,
      expected: state.writers[Math.floor(index / COUNT)].counts[kind], missing: state.writers[Math.floor(index / COUNT)].counts[kind] - pair.endToEnd.length,
      duplicates: pair.duplicates, endToEndMs: summary(pair.endToEnd), uplinkMs: summary(pair.uplink),
      relayMs: summary(pair.relay), downlinkMs: summary(pair.downlink) })));
    phase.frames = { sent: state.operations.size, serverReceived: state.serverFrames, serverDuplicates: state.serverDuplicates,
      clientReceived: state.clientFrames, expectedDeliveries: state.operations.size * COUNT, uniqueDeliveries: state.deliveries,
      missingDeliveries: state.operations.size * COUNT - state.deliveries };
    phase.propagation = state.pairs.map((pairs, kind) => ({ kind: kind ? "update" : "awareness",
      directedPairs: summary(pairs.flatMap((pair, index) => Math.floor(index / COUNT) === index % COUNT ? [] : pair.endToEnd)),
      echo: summary(pairs.flatMap((pair, index) => Math.floor(index / COUNT) === index % COUNT ? pair.endToEnd : [])) }));
    phase.checks = { allConnectsConfirmed: state.actors.length === COUNT && state.actors.every((actor) => actor.statuses.length === 1 && actor.statuses[0] === 200),
      everyWriterMaintainedCadence: phase.writers.every((writer) => writer.frames.every((frame) => frame.count === frame.expected && frame.skippedTicks === 0 && frame.outsideWindow === 0)),
      allFramesDelivered: state.operations.size === MAX_OPERATIONS && state.deliveries === state.operations.size * COUNT,
      noDuplicateFrames: state.serverDuplicates === 0 && phase.pairs.every((pair) => pair.duplicates === 0) };
    for (const actor of state.actors) actor.close(); for (const peer of state.peers.values()) peer.terminate(); active = undefined;
    await save();
  }
}

try {
  await mkdir(new URL("../../temp/performance/duplex-network/", import.meta.url), { recursive: true });
  await writeFile(reportFile, `${JSON.stringify(report, null, 2)}\n`, { flag: "wx", mode: 0o600 }); reportOwned = true;
  report.networkSourceSha256 = await networkSourceHash(); await save();
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(18991, "127.0.0.1", resolve); }); listening = true;
  for (let index = 0; index < COUNT; index += 1) {
    lifecycle.check(); const helper = await startHelper(async (descriptor) => { report.helperAttempts.push({ index, ...descriptor }); await save(); });
    helpers.push(helper); report.helpers.push({ index, ...helper.metadata }); await save();
  }
  await measurePhase(1, 0); lifecycle.check(); await measurePhase(2, 50); lifecycle.check();
  report.measurementValid = report.phases.length === 2 && report.phases.every((phase) => phase.status === "complete" &&
    Object.keys(phase.checks ?? {}).length === 4 && Object.values(phase.checks).every((value) => value === true));
  report.status = report.measurementValid ? "complete" : "diagnostic-invalid";
  if (!report.measurementValid) process.exitCode = 1;
} catch (error) { report.status = "failed"; report.error = error instanceof Error ? error.message.split(/\r?\n/)[0] : "Inert diagnostic failed"; process.exitCode = 1; }
finally {
  const cleanup = async (step, operation) => { if (!await cleanupStep(report, step, operation)) { report.status = "failed"; process.exitCode = 1; } };
  stopSockets();
  await Promise.all(helpers.map((helper, index) => cleanup(`owned helper-${index}`, () => helper.close())));
  await cleanup("inert WebSocket server", () => new Promise((resolve) => websocket.close(resolve)));
  await cleanup("inert HTTP server", async () => { if (listening) { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); } });
  try {
    if (reportOwned) await lifecycle.finalize(report, save);
    process.stdout.write(`${JSON.stringify({ status: report.status, measurementValid: report.measurementValid, interruption: report.interruption, error: report.error, reportFile })}\n`);
  } finally { lifecycle.dispose(); }
}
