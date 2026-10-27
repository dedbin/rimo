import { monitorEventLoopDelay } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";

import { distribution, fail, safeError, waitFor, Y } from "../common.mjs";
import { measureMove } from "../network/browser-probe.mjs";
import { assertHealthy } from "./actors.mjs";
import { cadence, CausalDeliveries, dueTick } from "./methodology.mjs";

export async function runActiveWindow({ nodes, browsers, targets, seconds, signal, progress }) {
  const actors = [...nodes, ...browsers];
  const started = performance.now() + 100;
  const end = started + seconds * 1_000;
  const writers = actors.map((actor, index) => ({ actor, target: { ...[...targets.nodes, ...targets.browsers][index] },
    sequence: 0, edits: [], presence: [], skippedEdits: 0, skippedPresence: 0 }));
  const causal = new CausalDeliveries(nodes.map((actor) => actor.label));
  const operations = []; const samples = []; const disposers = [];
  const controller = new AbortController();
  const eventLoop = monitorEventLoopDelay({ resolution: 10 });
  let firstError; let cleanupPending; let causalDrainMs;
  const stop = (error) => {
    firstError ??= error;
    if (controller.signal.aborted) return;
    controller.abort(error);
    cleanupPending = Promise.allSettled(actors.map((actor) => actor.close()));
  };
  const interrupt = () => stop(signal.reason ?? fail("Active-room run interrupted"));
  signal.addEventListener("abort", interrupt, { once: true });
  if (signal.aborted) interrupt();
  eventLoop.enable();
  for (const actor of nodes) {
    actor.peer.resetStatistics();
    const observe = () => {
      if (controller.signal.aborted) return;
      try { causal.observe(actor.label, Y.decodeStateVector(Y.encodeStateVector(actor.peer.document)), performance.now()); }
      catch (error) { stop(error); }
    };
    actor.peer.document.on("afterTransaction", observe);
    disposers.push(() => actor.peer.document.off("afterTransaction", observe));
  }
  const sleep = (milliseconds) => delay(milliseconds, undefined, { signal: controller.signal });
  const nodeLoop = async () => {
    const deadlines = nodes.map(() => ({ edit: started, presence: started }));
    while (performance.now() < end) {
      controller.signal.throwIfAborted(); assertHealthy(actors);
      const now = performance.now();
      if (now < started) { await sleep(10); continue; }
      for (let index = 0; index < nodes.length; index += 1) {
        const writer = writers[index]; const peer = nodes[index].peer; const next = deadlines[index];
        const presenceTick = dueTick(next.presence, now, 100);
        if (presenceTick) {
          next.presence = presenceTick.next; writer.skippedPresence += presenceTick.skipped;
          peer.provider.awareness?.setLocalState({ user: peer.session.user, presence: {
            cursor: { x: 200 + writer.presence.length % 1_000, y: 180 }, selection: [writer.target.id], pencilDraft: null,
            eraserDraft: null, penColor: null, penSize: 16, drag: null,
          } });
          writer.presence.push(performance.now());
        }
        const editTick = dueTick(next.edit, now, 500);
        if (!editTick) continue;
        next.edit = editTick.next; writer.skippedEdits += editTick.skipped; writer.sequence += 1;
        const sent = performance.now();
        const x = targets.nodes[index].x + writer.sequence % 2;
        peer.document.transact(() => peer.document.getMap("layers").get(writer.target.id).set("x", x), "active-room-final-operation");
        const clock = Y.decodeStateVector(Y.encodeStateVector(peer.document)).get(peer.document.clientID);
        causal.sent(nodes[index].label, peer.document.clientID, clock, sent);
        writer.target.x = x; writer.edits.push(sent);
      }
      await sleep(10);
    }
  };
  const browserLoop = async (index) => {
    const source = browsers[index]; const destination = browsers[1 - index]; const writer = writers[8 + index];
    let next = started;
    while (performance.now() < end) {
      controller.signal.throwIfAborted(); assertHealthy(actors);
      const tick = dueTick(next, performance.now(), 1_000);
      if (!tick) { await sleep(10); continue; }
      next = tick.next; writer.skippedEdits += tick.skipped;
      const dx = writer.sequence % 2 ? -20 : 20;
      const operation = { source: source.label, destination: destination.label, sequence: writer.sequence + 1, status: "pending" };
      operations.push(operation);
      const value = await measureMove(source.page, destination.page, writer.target, dx);
      const epoch = await source.page.evaluate(() => window.__rimoNetwork.pointerUpAt);
      const sent = epoch - performance.timeOrigin;
      if (!Number.isFinite(value) || value < 0 || !Number.isFinite(sent)) throw fail("Invalid browser final-operation timing");
      operation.status = "delivered"; operation.milliseconds = value; operation.pointerUpFromStartMs = sent - started;
      operation.insideActiveWindow = sent >= started && sent <= end;
      writer.edits.push(sent); writer.sequence += 1; writer.target.x += dx;
    }
  };
  const sampleLoop = async () => {
    while (performance.now() < end) {
      controller.signal.throwIfAborted();
      if (performance.now() < started) { await sleep(10); continue; }
      assertHealthy(actors);
      const connections = nodes.filter((actor) => actor.connected).length +
        (await Promise.all(browsers.map((actor) => actor.connections()))).reduce((sum, count) => sum + count, 0);
      const sample = { fromStartMs: performance.now() - started, connections, pendingCausalOperations: causal.pending.size,
        highestNodeBufferedBytes: Math.max(...nodes.map((actor) => actor.peer.bufferedAmount)), generator: {
          rssBytes: process.memoryUsage().rss, heapUsedBytes: process.memoryUsage().heapUsed,
          eventLoopP95Ms: eventLoop.percentile(95) / 1e6, eventLoopMaxMs: eventLoop.max / 1e6 } };
      samples.push(sample); eventLoop.reset();
      if (connections !== 10) throw fail("The active window lost one of its ten collaboration connections");
      if (samples.length % 5 === 1) await progress({ elapsedSeconds: Math.round(sample.fromStartMs / 1_000), connections, nodeOperations: causal.operations,
        browserOperations: operations.length, pendingCausalOperations: causal.pending.size });
      await sleep(Math.min(1_000, Math.max(1, end - performance.now())));
    }
  };
  try {
    const tasks = [nodeLoop(), browserLoop(0), browserLoop(1), sampleLoop()];
    await Promise.allSettled(tasks.map((task) => task.catch((error) => { stop(error); })));
    if (firstError) throw firstError;
    signal.throwIfAborted();
    const drainStarted = performance.now();
    await waitFor(() => { assertHealthy(actors); return causal.pending.size === 0; }, 20_000, signal);
    causalDrainMs = performance.now() - drainStarted;
  } catch (error) { firstError ??= error; }
  finally {
    disposers.forEach((dispose) => dispose()); eventLoop.disable();
    signal.removeEventListener("abort", interrupt);
    await cleanupPending;
  }
  return { error: firstError ? safeError(firstError) : null, requestedSeconds: seconds,
    windowStartedEpochMs: performance.timeOrigin + started, windowEndedEpochMs: performance.timeOrigin + end,
    completedAfterStartMs: performance.now() - started, causalDrainMs,
    minimumConnections: samples.length ? Math.min(...samples.map((sample) => sample.connections)) : null,
    maximumConnections: samples.length ? Math.max(...samples.map((sample) => sample.connections)) : null,
    writers: writers.map((writer) => ({ label: writer.actor.label, kind: writer.actor.kind, targetId: writer.target.id,
      edits: cadence(writer.edits, started, end, writer.actor.kind === "node" ? 2 : 1, writer.skippedEdits),
      ...(writer.actor.kind === "node" ? { presence: cadence(writer.presence, started, end, 10, writer.skippedPresence) } : {}) })),
    browserPropagation: browsers.map((actor) => {
      const attempts = operations.filter((entry) => entry.source === actor.label);
      const delivered = attempts.filter((entry) => entry.status === "delivered");
      return { source: actor.label, destination: browsers.find((peer) => peer !== actor).label, attempts: attempts.length,
        undelivered: attempts.length - delivered.length, outsideWindow: delivered.filter((entry) => !entry.insideActiveWindow).length,
        ...distribution(delivered.map((entry) => entry.milliseconds)) };
    }), causal: causal.summary(), finalTargets: writers.map((writer) => ({ ...writer.target })), operations, samples };
}
