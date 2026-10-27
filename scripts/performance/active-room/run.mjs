import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { api, createBoard, dockerEnvironment, environment, fail, ownerContext, positiveInteger, removeBoards,
  roundTrip, safeError, viewerContext, waitFor, writeReport, Y } from "../common.mjs";
import { imageAsset, seedScene } from "../fixture.mjs";
import { collaborationRoundTrip } from "../network/browser-probe.mjs";
import { cleanupStep, NETWORK_CALIBRATION_FILE, networkSourceHash, startHelper } from "../network/helper.mjs";
import { createRunLifecycle } from "../network/lifecycle.mjs";
import { inspectProject } from "../service-target.mjs";
import { assertHealthy, browserCoordinates, openBrowserActor, openNodeActor } from "./actors.mjs";
import { acceptanceStatus, actorTargets, criteria, roundTripEvidence, tcClasses, trafficEvidence, validateCalibration, validateHelper } from "./methodology.mjs";
import { runActiveWindow } from "./workload.mjs";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const directory = fileURLToPath(new URL(".", import.meta.url));
const artifactRoot = path.join(root, "temp/performance/active-room");

async function sourceHash() {
  const hash = createHash("sha256");
  for (const name of (await readdir(directory)).filter((name) => name.endsWith(".mjs")).toSorted()) {
    hash.update(name); hash.update(await readFile(path.join(directory, name)));
  }
  for (const name of ["common", "cookies", "fixture", "service-target"]) {
    const filename = `scripts/performance/${name}.mjs`; hash.update(filename); hash.update(await readFile(path.join(root, filename)));
  }
  for (const filename of ["lib/collaboration/offline-sync.ts", "lib/collaboration/protocol.ts"]) {
    hash.update(filename); hash.update(await readFile(path.join(root, filename)));
  }
  return hash.digest("hex");
}

async function options() {
  const { values } = parseArgs({ options: {
    help: { type: "boolean" }, "allow-service-test": { type: "boolean", default: false }, seconds: { type: "string", default: "120" },
    "base-url": { type: "string", default: "http://localhost:3080" }, "compose-project": { type: "string", default: "rimo-rework" },
    "storage-state": { type: "string", default: "temp/performance/network-owner-storage.json" },
    label: { type: "string", default: "mixed10active" }, output: { type: "string" },
  } });
  if (values.help) {
    process.stdout.write("node --import=tsx scripts/performance/active-room/run.mjs --allow-service-test --storage-state PRIVATE_FILE [--seconds 120] [--label LABEL] [--output temp/performance/active-room/RUN/report.json]\nTwo Chromium processes and eight Node providers, ten independent calibrated network helpers. Run only in an agreed quiet window.\n");
    return null;
  }
  if (!values["allow-service-test"]) throw fail("Active-room service test requires explicit --allow-service-test and an agreed run window");
  const seconds = positiveInteger(values.seconds, "seconds", 300);
  if (seconds < 60) throw fail("Active-room measurement needs at least 60 seconds and 50 browser samples per direction");
  const origin = new URL(values["base-url"]);
  if (origin.href !== "http://localhost:3080/") throw fail("Only the isolated http://localhost:3080 origin is supported");
  if (!/^[a-zA-Z0-9_.-]{1,80}$/.test(values.label)) throw fail("Use a short non-sensitive label with letters, numbers, dots, dashes or underscores");
  if (path.resolve(process.cwd()).toLowerCase() !== path.resolve(root).toLowerCase()) throw fail("Run active-room from the repository root");
  const output = path.resolve(values.output ?? path.join(artifactRoot, randomUUID(), "report.json"));
  if (!output.startsWith(`${artifactRoot}${path.sep}`) || !output.endsWith(".json")) throw fail("Active-room reports must remain inside temp/performance/active-room");
  await mkdir(path.dirname(output), { recursive: true });
  const actual = await realpath(path.dirname(output));
  if (!actual.toLowerCase().startsWith(`${artifactRoot.toLowerCase()}${path.sep}`)) throw fail("Active-room output parent must not redirect outside its artifact directory");
  const claim = await open(output, "wx", 0o600); await claim.close();
  return { ...values, seconds, baseURL: origin.origin, output };
}

async function main(values) {
  const report = { kind: "mixed-ten-active-connections", status: "running", at: new Date().toISOString(), label: values.label,
    environment: null, service: null, projectBinding: null, harnessSha256: null, networkSourceSha256: null, calibration: null,
    helperAttempts: [], actorAttempts: [], helpers: [], paths: [], clients: [], createdBoards: [], cleanup: [],
    methodology: {
      clients: "two independent Chromium processes plus eight Node providers; owner and anonymous editor are two reused sessions, not ten unique users",
      fixture: "3000 objects, 500 visible, 50 visible images using one unique asset; ten disjoint rectangle targets",
      writers: "each Node provider 2Hz final Yjs changes and 10Hz awareness; each browser 1Hz real gestures; fixed schedule skips missed ticks without catch-up bursts",
      browserLatency: "capture pointerup -> peer persistent rectangle style mutation, two directed browser paths; same-host clocks; no compositor/pixel claim",
      nodeLatency: "before local transaction -> receiver Yjs state vector includes sender end clock, 56 directed Node pairs; all late/missing operations retained",
      persistence: "no per-gesture Saved wait during continuous writes; final snapshot ACK and Saved drain only after all writers stop",
      network: "one private helper per active connection, 50ms each direction and aggregate 50Mbit/s each direction per participant; no direct fallback or CDP latency emulation",
      audit: "seed closed before the ten-actor window; fresh WS audit only after all ten actors close; service process/cache not restarted",
    } };
  const helpers = []; const actors = []; const resources = [];
  let owner; let guest; let boardId; let scene;
  const lifecycle = createRunLifecycle((values.seconds + 480) * 1_000, () => Promise.allSettled(resources.map((actor) => actor.close())));
  const save = () => writeReport(values.output, report, true);
  const progress = async (phase) => { report.phase = phase; await save(); process.stdout.write(`${JSON.stringify({ event: "active_room_progress", phase })}\n`); };
  const onCreated = (actor) => { resources.push(actor); report.actorAttempts.push({ label: actor.label, kind: actor.kind }); };
  const cleanup = (step, operation) => cleanupStep(report, step, operation);
  const helperFor = async (label) => {
    lifecycle.check();
    report.phase = `preparing-helper-${label}`;
    const helper = await startHelper(async (descriptor) => { report.helperAttempts.push({ label, ...descriptor }); await save(); });
    helpers.push(helper); report.helpers.push({ label, ...helper.metadata });
    lifecycle.check(); validateHelper(helper.metadata, report.calibration);
    await helper.configure([3080], 50);
    return helper;
  };
  try {
    report.networkSourceSha256 = await networkSourceHash();
    report.calibration = JSON.parse(await readFile(NETWORK_CALIBRATION_FILE, "utf8"));
    validateCalibration(report.calibration, report.networkSourceSha256);
    await progress("calibration-validated");
    [report.environment, report.service, report.harnessSha256] = await Promise.all([
      environment(values.label), dockerEnvironment(values["compose-project"]), sourceHash(),
    ]);
    report.projectBinding = await inspectProject(values["compose-project"]);
    report.dependencies = { httpsProxyAgent: JSON.parse(await readFile(path.join(root, "node_modules/https-proxy-agent/package.json"), "utf8")).version };
    if (report.dependencies.httpsProxyAgent !== "7.0.6") throw fail("Use the pinned https-proxy-agent 7.0.6 dependency");
    lifecycle.check();
    owner = await ownerContext(values.baseURL, values["storage-state"]);
    guest = await viewerContext(values.baseURL, path.join(artifactRoot, "guest-storage.json"));
    boardId = await createBoard(owner, `Active-room fixture ${Date.now()}`); report.createdBoards.push(boardId);
    const ownerState = await owner.storageState();
    const helper = await helperFor("node-0");
    await progress("seeding-before-ten-connections");
    const seed = await openNodeActor({ label: "seed", helper, baseURL: values.baseURL, boardId, storageState: ownerState, signal: lifecycle.signal, onCreated });
    scene = seedScene(seed.peer.document, 3_000, await imageAsset(owner, boardId));
    await waitFor(() => { assertHealthy([seed]); return seed.peer.isPersisted(); }, 20_000, lifecycle.signal);
    report.fixture = { objects: scene.objects, visibleObjects: scene.visibleObjects, visibleImages: scene.visibleDistribution[5],
      uniqueImages: 1, documentBytes: Y.encodeStateAsUpdate(seed.peer.document).byteLength };
    await seed.close(); report.seedClosedBeforeMeasurement = true;
    const invite = await api(owner, "POST", `/api/boards/${boardId}/invites`, { role: "editor", expiresInHours: 1 });
    await api(guest.context, "POST", "/api/invites/accept", { token: invite.token, name: "Active-room fixture editor" });
    const guestState = await guest.context.storageState();
    for (let index = 1; index < 8; index += 1) await helperFor(`node-${index}`);
    await helperFor("browser-owner"); await helperFor("browser-editor");
    await progress("opening-ten-actors");
    for (let index = 0; index < 8; index += 1) {
      lifecycle.check();
      await progress(`opening-node-${index}`);
      actors.push(await openNodeActor({ label: `node-${index}`, helper: helpers[index], baseURL: values.baseURL, boardId,
        storageState: ownerState, signal: lifecycle.signal, onCreated }));
    }
    for (const [index, storageState] of [ownerState, guestState].entries()) {
      lifecycle.check();
      await progress(index ? "opening-browser-editor" : "opening-browser-owner");
      actors.push(await openBrowserActor({ label: index ? "browser-editor" : "browser-owner", helper: helpers[8 + index], baseURL: values.baseURL,
        boardId, storageState, assetUrl: scene.assetUrl, signal: lifecycle.signal, onCreated }));
    }
    report.clients = actors.map((actor) => actor.snapshot());
    report.paths = actors.map((actor) => ({ label: actor.label, kind: actor.kind, connectStatuses: [...(actor.connectStatuses ?? [])], upgradeStatuses: [...(actor.upgradeStatuses ?? [])] }));
    await progress("validating-ten-shaped-websocket-paths");
    const rtt = await Promise.allSettled(actors.map(async (actor, index) => {
      const values = [];
      for (let trial = 0; trial < 5; trial += 1) { lifecycle.check(); values.push(await (actor.kind === "node" ? roundTrip(actor.peer) : collaborationRoundTrip(actor.page, boardId))); }
      report.paths[index].roundtrip = roundTripEvidence(values);
    }));
    const badRtt = rtt.find((entry) => entry.status === "rejected"); if (badRtt) throw badRtt.reason;
    const before = await Promise.all(helpers.map((entry) => entry.statistics())); before.forEach(tcClasses);
    lifecycle.check();
    await progress("ten-writers-active");
    report.workload = await runActiveWindow({ nodes: actors.slice(0, 8), browsers: actors.slice(8), targets: actorTargets(scene.positions), seconds: values.seconds,
      signal: lifecycle.signal, progress: async (partial) => { report.partial = partial; await save(); process.stdout.write(`${JSON.stringify({ event: "active_room_sample", ...partial })}\n`); } });
    report.error ??= report.workload.error ?? undefined;
    lifecycle.check();
    const after = await Promise.all(helpers.map((entry) => entry.statistics()));
    report.paths.forEach((entry, index) => {
      entry.connectStatuses = [...(actors[index].connectStatuses ?? [])]; entry.upgradeStatuses = [...(actors[index].upgradeStatuses ?? [])];
      entry.beforeTc = before[index]; entry.afterTc = after[index]; entry.traffic = trafficEvidence(before[index], after[index]);
    });
    if (report.workload.error) throw fail(report.workload.error);
    await progress("all-writers-stopped-final-saved-drain");
    const drainStarted = performance.now();
    for (const actor of actors.slice(0, 8)) actor.peer.provider.sendStateless(JSON.stringify({ type: "persistence-status" }));
    await waitFor(() => { assertHealthy(actors); return actors.slice(0, 8).every((actor) => actor.peer.isPersisted()); }, 20_000, lifecycle.signal);
    for (const actor of actors.slice(0, 8)) for (const target of report.workload.finalTargets) {
      const layer = actor.peer.document.getMap("layers").get(target.id);
      if (layer?.get("x") !== target.x || layer.get("y") !== target.y) throw fail("A Node document did not converge to all ten final operations");
    }
    await Promise.all(actors.slice(8).map(async (actor) => {
      await browserCoordinates(actor.page, report.workload.finalTargets);
      await actor.page.getByText("Сохранено", { exact: true }).waitFor({ timeout: 20_000 });
    }));
    report.finalDrain = { milliseconds: performance.now() - drainStarted, allNodeSnapshotsAcknowledged: true, bothBrowsersSaved: true, browserCoordinatesConverged: true };
    assertHealthy(actors); report.clients = actors.map((actor) => actor.snapshot());
    const closed = await Promise.all(actors.map((actor) => cleanup(`measured actor ${actor.label}`, () => actor.close())));
    if (closed.some((value) => !value)) throw fail("Could not release all ten actors before the audit");
    lifecycle.check(); await progress("ten-actors-closed-fresh-durable-audit");
    report.audit = { actorsClosedBeforeAudit: true, allCoordinatesMatch: false, persisted: false };
    const audit = await openNodeActor({ label: "audit", helper: helpers[0], baseURL: values.baseURL, boardId, storageState: ownerState, signal: lifecycle.signal, onCreated });
    const expected = new Map(scene.positions);
    for (const target of report.workload.finalTargets) expected.set(target.id, { x: target.x, y: target.y });
    if (audit.peer.document.getMap("layers").size !== 3_000) throw fail("Fresh audit found an incorrect object count");
    for (const [id, position] of expected) {
      const layer = audit.peer.document.getMap("layers").get(id);
      if (layer?.get("x") !== position.x || layer.get("y") !== position.y) throw fail("Fresh audit found an incorrect durable coordinate");
    }
    report.audit = { ...report.audit, allCoordinatesMatch: true, persisted: audit.peer.isPersisted(), revision: audit.peer.acknowledgement?.revision,
      documentBytes: Y.encodeStateAsUpdate(audit.peer.document).byteLength, objectCount: expected.size };
    lifecycle.check(); report.phase = "finished";
  } catch (error) {
    report.error ??= safeError(error); process.exitCode = 1;
    if (error?.networkHelper) { report.helperRecoveryRequired = error.networkHelper; report.cleanup.push({ step: "helper setup recovery", status: "failed" }); }
  } finally {
    // Every resource has its own guarded cleanup; one failure cannot skip the rest.
    if (actors.length) report.clients = actors.map((actor) => actor.snapshot());
    report.actorResults = resources.map((actor) => actor.snapshot());
    await Promise.all(resources.map((actor) => cleanup(`actor ${actor.label}`, () => actor.close())));
    await Promise.all(helpers.map((helper, index) => cleanup(`owned helper ${index}`, () => helper.close())));
    if (owner && boardId) await cleanup("created fixture board", async () => {
      if ((await removeBoards(owner, [boardId])).length) throw fail("Fixture board cleanup failed");
    });
    await Promise.all([cleanup("owner API context", () => owner?.dispose()), cleanup("guest API context", () => guest?.context.dispose())]);
    try {
      await lifecycle.finalize(report, async () => {
        report.criteria = criteria(report); report.status = acceptanceStatus(report);
        if (report.status !== "accepted" && !process.exitCode) process.exitCode = 1;
        await writeReport(values.output, report);
      });
    } finally { lifecycle.dispose(); }
  }
}

try { const values = await options(); if (values) await main(values); }
catch (error) { process.stderr.write(`${safeError(error)}\n`); process.exitCode = 1; }
