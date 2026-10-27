import { createHistogram, monitorEventLoopDelay } from "node:perf_hooks";

import { distribution, dockerSample, fail, roundTrip, safeError, waitFor, Y } from "./common.mjs";
import { idAt } from "./fixture.mjs";

export async function runLoad(rooms, options, signal, progress) {
  const peers = rooms.flatMap((room) => room.clients);
  const pending = new Map();
  const latencies = createHistogram({ lowest: 1, highest: 60_000_000_000, figures: 3 });
  const acknowledgements = [];
  const samples = [];
  const handlers = [];
  let sentChanges = 0;
  let presenceMessages = 0;
  let missingDeliveries = 0;
  let highestPending = 0;
  let highestBuffered = 0;
  let skippedEditTicks = 0;
  let failure = null;
  let sampling;
  let sampleFailure;
  let steadyDurationSeconds = 0;
  const eventLoop = monitorEventLoopDelay({ resolution: 10 });
  eventLoop.enable();
  const started = performance.now();
  for (const room of rooms) {
    const width = Math.min(options.batchSize, Math.floor(options.objects / room.writers.length) || 1);
    room.writers.forEach((writer, index) => {
      writer.layerIds = Array.from({ length: width }, (_entry, offset) => idAt(index * width + offset));
      writer.nextEdit = 0; writer.nextPresence = 0; writer.nextBatch = started + options.batchEverySeconds * 1_000;
      writer.sequence = 0; writer.expectedX = writer.document.getMap("layers").get(writer.layerIds[0]).get("x");
    });
    for (const peer of room.clients) {
      const observe = () => {
        const vector = Y.decodeStateVector(Y.encodeStateVector(peer.document));
        for (const [key, entry] of pending) {
          if (entry.boardId !== room.boardId || entry.source === peer || entry.seen.has(peer) ||
              (vector.get(entry.clientId) ?? 0) < entry.endClock) continue;
          entry.seen.add(peer);
          latencies.record(Math.max(1, Math.round((performance.now() - entry.start) * 1e6)));
          if (entry.seen.size === entry.expected) pending.delete(key);
        }
      };
      peer.document.on("afterTransaction", observe);
      handlers.push(() => peer.document.off("afterTransaction", observe));
      peer.resetStatistics();
    }
  }
  const takeSample = async () => {
    const now = performance.now();
    for (const [key, entry] of pending) if (now - entry.start > 15_000) {
      missingDeliveries += entry.expected - entry.seen.size; pending.delete(key);
    }
    const ackLag = peers.map((peer) => peer.acknowledgement ? now - peer.acknowledgement.receivedAt : null).filter((entry) => entry !== null);
    const sample = { elapsedSeconds: (now - started) / 1_000, generator: { rssBytes: process.memoryUsage().rss,
      heapUsedBytes: process.memoryUsage().heapUsed, eventLoopP95Ms: eventLoop.percentile(95) / 1e6,
      eventLoopMaxMs: eventLoop.max / 1e6 },
      pendingChanges: pending.size, changes: sentChanges, connections: peers.filter((peer) => !peer.failure && peer.provider.isSynced).length,
      acknowledgementAgeMs: distribution(ackLag), docker: null };
    const [roundTrips, docker] = await Promise.all([
      Promise.all(rooms.map((room) => roundTrip(room.clients[0]))), dockerSample(options.composeProject),
    ]);
    sample.observedRoundTripMs = distribution(roundTrips.filter((value) => value !== null));
    sample.roundTripTimeouts = roundTrips.filter((value) => value === null).length;
    sample.docker = docker;
    samples.push(sample); eventLoop.reset();
    await progress({ elapsedSeconds: Math.round(sample.elapsedSeconds), connections: sample.connections, changes: sample.changes, pending: sample.pendingChanges,
      sample, partial: { sentChanges, presenceMessages, pendingChanges: pending.size, missingDeliveries } });
  };
  let nextSample = started;
  try {
    while (performance.now() - started < options.seconds * 1_000 && !signal.aborted) {
      if (sampleFailure) throw sampleFailure;
      const now = performance.now();
      for (const room of rooms) for (const writer of room.writers) {
        if (writer.failure) throw fail(writer.failure);
        highestBuffered = Math.max(highestBuffered, writer.bufferedAmount);
        if (now >= writer.nextPresence) {
          writer.provider.awareness?.setLocalState({ user: writer.session.user, presence: {
            cursor: { x: 200 + writer.sequence % 500, y: 250 }, selection: [writer.layerIds[0]], pencilDraft: null,
            eraserDraft: null, penColor: null, penSize: 16, drag: null,
          } });
          presenceMessages += 1; writer.nextPresence = now + 1_000 / options.presenceHz;
        }
        if (now < writer.nextEdit) continue;
        if (writer.nextEdit > 0 && now - writer.nextEdit > 1_000 / options.editHz) skippedEditTicks += 1;
        writer.nextEdit = now + 1_000 / options.editHz;
        writer.sequence += 1;
        const batch = now >= writer.nextBatch;
        if (batch) writer.nextBatch = now + options.batchEverySeconds * 1_000;
        const ids = batch ? writer.layerIds : [writer.layerIds[0]];
        writer.expectedX += 1;
        const key = `${room.boardId}:${writer.document.clientID}:${writer.sequence}`;
        const entry = { start: performance.now(), expected: room.clients.length - 1, seen: new Set(),
          boardId: room.boardId, source: writer, clientId: writer.document.clientID, endClock: Infinity };
        pending.set(key, entry);
        if (room.clients.length === 1) pending.delete(key);
        highestPending = Math.max(highestPending, pending.size);
        writer.document.transact(() => {
          for (const id of ids) {
            const layer = writer.document.getMap("layers").get(id);
            layer.set("x", layer.get("x") + 1);
          }
        }, "load-gesture-commit");
        entry.endClock = Y.decodeStateVector(Y.encodeStateVector(writer.document)).get(writer.document.clientID);
        sentChanges += 1;
      }
      if (peers.some((peer) => peer.failure)) throw fail(peers.find((peer) => peer.failure).failure);
      if (now >= nextSample && !sampling) {
        sampling = takeSample().catch((error) => { sampleFailure = error; }).finally(() => { sampling = undefined; });
        nextSample = now + options.sampleSeconds * 1_000;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    steadyDurationSeconds = (performance.now() - started) / 1_000;
    const drainStarted = performance.now();
    await waitFor(() => peers.every((peer) => { if (peer.failure) throw fail(peer.failure); return peer.isPersisted(); }), 20_000);
    acknowledgements.push(performance.now() - drainStarted);
    for (const room of rooms) for (const peer of room.clients) for (const writer of room.writers) {
      if (peer.document.getMap("layers").get(writer.layerIds[0]).get("x") !== writer.expectedX) throw fail("Clients did not converge to the last confirmed operation");
    }
    await sampling;
    if (sampleFailure) throw sampleFailure;
    await takeSample();
  } catch (error) { failure = safeError(error); }
  finally { await sampling; handlers.forEach((dispose) => dispose()); eventLoop.disable(); }
  return { error: failure, interrupted: signal.aborted, durationSeconds: (performance.now() - started) / 1_000,
      steadyDurationSeconds: steadyDurationSeconds || (performance.now() - started) / 1_000,
      actualEditsPerWriterHz: sentChanges / ((steadyDurationSeconds || (performance.now() - started) / 1_000) * rooms.reduce((total, room) => total + room.writers.length, 0)),
      sentChanges, presenceMessages, skippedEditTicks, propagationMs: { count: latencies.count,
        p50: latencies.count ? latencies.percentile(50) / 1e6 : null,
        p95: latencies.count ? latencies.percentile(95) / 1e6 : null,
        max: latencies.count ? latencies.max / 1e6 : null },
      finalAcknowledgementDrainMs: distribution(acknowledgements), pendingAtEnd: pending.size,
      highestPendingChanges: highestPending, missingDeliveries, highestClientBufferedBytes: highestBuffered,
      workload: { editHz: options.editHz, presenceHz: options.presenceHz, batchEverySeconds: options.batchEverySeconds,
        batchSizesPerRoom: rooms.map((room) => room.writers.map((writer) => writer.layerIds.length)) },
      samples, documents: rooms.map((room) => ({ boardId: room.boardId, bytes: Y.encodeStateAsUpdate(room.clients[0].document).byteLength,
        revision: room.clients[0].acknowledgement?.revision })),
      clients: peers.map((peer) => ({ boardId: peer.boardId, role: peer.session.role,
        failure: peer.failure, closeEvent: peer.closeEvent, wire: peer.stats })) };
}
