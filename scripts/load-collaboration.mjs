import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";

import { api, createBoard, dockerEnvironment, environment, fail, installLoadInterruptHandlers, openProvider, ownerContext, positiveInteger, removeBoards, safeError, viewerContext, waitFor, writeFinalReport, writeReport, Y } from "./performance/common.mjs";
import { imageAsset, seedScene } from "./performance/fixture.mjs";
import { runLoad } from "./performance/load-runner.mjs";

const { values } = parseArgs({ options: {
  help: { type: "boolean" }, "base-url": { type: "string", default: "http://localhost:3000" },
  "storage-state": { type: "string", default: "temp/browser-owner-storage.json" },
  "viewer-storage-state": { type: "string", default: "temp/performance-viewer-storage.json" },
  output: { type: "string", default: `temp/performance/load-${Date.now()}.json` },
  label: { type: "string", default: "local-production-diagnostic" },
  "background-tasks": { type: "string", default: "not recorded" },
  rooms: { type: "string", default: "1" }, connections: { type: "string", default: "10" }, editors: { type: "string", default: "2" },
  seconds: { type: "string", default: "30" }, objects: { type: "string", default: "3000" },
  "edit-hz": { type: "string", default: "2" }, "presence-hz": { type: "string", default: "10" },
  "batch-size": { type: "string", default: "500" }, "batch-every-seconds": { type: "string", default: "30" },
  "sample-seconds": { type: "string", default: "10" }, "compose-project": { type: "string" },
  "network-label": { type: "string", default: "loopback; no artificial RTT applied" },
  "start-signal": { type: "string" },
} });

if (values.help) {
  process.stdout.write("node --import=tsx scripts/load-collaboration.mjs [--base-url URL] [--storage-state FILE] [--viewer-storage-state FILE] [--seconds 30] [--rooms 1] [--connections 10] [--editors 2] [--objects 3000] [--compose-project NAME] [--output FILE] [--label LABEL]\nFor >300 seconds set RIMO_RUN_LONG_LOAD=1 explicitly. Plan A: --seconds 3600 --rooms 5 --connections 50 --editors 10.\n");
} else {
  await main().catch((error) => { process.stderr.write(`${safeError(error)}\n`); process.exitCode = 1; });
}

function allocate(total, rooms, index) { return Math.floor(total / rooms) + Number(index < total % rooms); }

async function main() {
  const options = {
    seconds: positiveInteger(values.seconds, "seconds", 14_400), rooms: positiveInteger(values.rooms, "rooms", 10),
    connections: positiveInteger(values.connections, "connections", 50), editors: positiveInteger(values.editors, "editors", 10),
    objects: positiveInteger(values.objects, "objects", 3_000), editHz: positiveInteger(values["edit-hz"], "edit-hz", 20),
    presenceHz: positiveInteger(values["presence-hz"], "presence-hz", 30), batchSize: positiveInteger(values["batch-size"], "batch-size", 500),
    batchEverySeconds: positiveInteger(values["batch-every-seconds"], "batch-every-seconds", 3_600),
    sampleSeconds: positiveInteger(values["sample-seconds"], "sample-seconds", 60), composeProject: values["compose-project"],
  };
  if (options.seconds > 300 && process.env.RIMO_RUN_LONG_LOAD !== "1") throw fail("Long load runs require explicit RIMO_RUN_LONG_LOAD=1");
  const startSignal = values["start-signal"] ? path.resolve(values["start-signal"]) : null;
  if (startSignal && (!startSignal.startsWith(path.resolve("temp/performance") + path.sep) || existsSync(startSignal))) {
    throw fail("A profiling start signal must be a new file inside temp/performance");
  }
  if (options.editors < options.rooms || options.editors > options.connections || options.connections > options.rooms * 10) {
    throw fail("Use at least one editor per room, editors <=connections and no more than10 connections per room");
  }
  const viewers = options.connections - options.editors;
  const report = { kind: "collaboration-load", version: 1, status: "running", targetOrigin: new URL(values["base-url"]).origin, environment: await environment(values.label), options,
    network: values["network-label"], backgroundTasks: values["background-tasks"], identity: { connections: options.connections, editorConnections: options.editors,
      uniqueUsers: viewers ? 2 : 1, reusedSessions: true, uniqueUsersClaim: false },
    methodology: { propagation: "Node provider update to all other Node providers in that room; no browser rendering is measured",
      acknowledgement: "Y.snapshot equality including delete sets; final drain waits for database persistence acknowledgements",
      memory: "generator RSS/heap/event-loop are separate from optional Docker service samples",
      queue: "pending fanout deliveries and client bufferedAmount are proxies; internal server queue length is not exposed",
      wire: "Hocuspocus application bytes without WebSocket/TCP/TLS overhead; no artificial RTT is implied" },
    fixture: [], cleanup: [] };
  const boards = [];
  const clients = [];
  const controller = new AbortController();
  const removeInterruptHandlers = installLoadInterruptHandlers(controller);
  let owner;
  let viewer;
  try {
    owner = await ownerContext(values["base-url"], values["storage-state"]);
    report.services = await dockerEnvironment(options.composeProject);
    if (viewers) {
      viewer = await viewerContext(values["base-url"], values["viewer-storage-state"]);
      report.viewerAccount = { createdThisRun: viewer.created, retainedForReuse: viewer.retained,
        reason: "Anonymous account deletion is disabled; only this run's boards/memberships/invites are removed" };
    }
    const rooms = [];
    for (let index = 0; index < options.rooms; index += 1) {
      if (controller.signal.aborted) throw fail("Interrupted while preparing fixtures");
      const boardId = await createBoard(owner, `Load fixture ${Date.now()} room ${index + 1}`);
      boards.push(boardId);
      report.createdBoards = boards;
      await writeReport(values.output, report);
      const seeder = await openProvider(owner, values["base-url"], boardId, controller.signal);
      try {
        const scene = seedScene(seeder.document, options.objects, await imageAsset(owner, boardId));
        await waitFor(() => seeder.isPersisted());
        report.fixture.push({ boardId, objects: scene.objects, visibleObjects: scene.visibleObjects, distribution: scene.distribution,
          visibleDistribution: scene.visibleDistribution, uniqueImages: scene.uniqueImages,
          documentBytes: Y.encodeStateAsUpdate(seeder.document).byteLength });
      } finally { await seeder.close(); }
      if (viewer) {
        const invitation = await api(owner, "POST", `/api/boards/${boardId}/invites`, { role: "viewer", expiresInHours: 24 });
        await api(viewer.context, "POST", "/api/invites/accept", { token: invitation.token, name: "Нагрузочный зритель" });
      }
      rooms.push({ boardId, clients: [], writers: [], editorCount: allocate(options.editors, options.rooms, index),
        viewerCount: allocate(viewers, options.rooms, index) });
    }
    for (const room of rooms) {
      if (room.editorCount + room.viewerCount > 10 || options.objects < room.editorCount) throw fail("The selected distribution exceeds a room or fixture limit");
      for (let index = 0; index < room.editorCount + room.viewerCount; index += 1) {
        if (controller.signal.aborted) throw fail("Interrupted while connecting clients");
        const editor = index < room.editorCount;
        const client = await openProvider(editor ? owner : viewer.context, values["base-url"], room.boardId, controller.signal);
        clients.push(client); room.clients.push(client);
        if (editor) room.writers.push(client);
        if (!editor && client.provider.authorizedScope !== "readonly") throw fail("Viewer fixture unexpectedly has write permission");
      }
    }
    report.checkpoints = [];
    if (startSignal) {
      report.externalStartSignalUsed = true;
      process.stdout.write(`${JSON.stringify({ event: "load_ready", connections: clients.length })}\n`);
      await waitFor(() => existsSync(startSignal), 60_000, controller.signal);
      await rm(startSignal);
    }
    report.result = await runLoad(rooms, options, controller.signal, async ({ sample, partial, ...summary }) => {
      report.checkpoints.push(sample);
      report.partial = partial;
      await writeReport(values.output, report, true);
      process.stdout.write(`${JSON.stringify({ event: "load_progress", ...summary })}\n`);
    });
    report.status = report.result.interrupted ? "interrupted" : "complete";
    if (report.result.error || report.result.missingDeliveries || report.result.pendingAtEnd) { report.status = "failed"; process.exitCode = 1; }
    report.editCadenceAtLeast95Percent = report.result.actualEditsPerWriterHz >= options.editHz * 0.95;
    if (!report.editCadenceAtLeast95Percent) { report.status = "failed"; process.exitCode = 1; }
  } catch (error) { report.status = "failed"; report.error = safeError(error); process.exitCode = 1; }
  finally {
    const closing = await Promise.allSettled(clients.map((client) => client.close()));
    report.closeErrors = closing.filter((entry) => entry.status === "rejected").map((entry) => safeError(entry.reason));
    const closeFailed = (error) => { report.closeErrors.push(safeError(error)); };
    if (owner) { report.cleanup = await removeBoards(owner, boards); await owner.dispose().catch(closeFailed); }
    await viewer?.context.dispose().catch(closeFailed);
    if (startSignal) await rm(startSignal, { force: true }).catch(closeFailed);
    if (report.cleanup.length || report.closeErrors.length) { report.status = "cleanup-failed"; process.exitCode = 1; }
    try { await writeFinalReport(values.output, report, controller.signal); }
    finally { removeInterruptHandlers(); }
  }
}
