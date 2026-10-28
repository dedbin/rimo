import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";

import { chromium, request } from "playwright";

import { avatarBrowserCase } from "./avatar-network-browser.mjs";
import { linuxAvatarCases } from "./avatar-network-linux.mjs";
import { verifyAvatarPeers } from "./avatar-network-peer.mjs";
import { api, createBoard, dockerEnvironment, fail, ownerContext, safeError, writeReport } from "./performance/common.mjs";
import { imageAsset } from "./performance/fixture.mjs";
import { inspectProject } from "./performance/service-target.mjs";

const { values } = parseArgs({ options: {
  help: { type: "boolean" }, "allow-service-test": { type: "boolean", default: false },
  "linux-browser": { type: "boolean", default: false },
  peer: { type: "boolean", default: false },
  "base-url": { type: "string", default: "http://localhost:3080" },
  "storage-state": { type: "string", default: "temp/docker-owner-storage.json" },
  "compose-project": { type: "string", default: "rimo-rework" },
  output: { type: "string", default: `temp/avatar-network/${randomUUID()}.json` },
} });

if (values.help) {
  process.stdout.write("node --import=tsx scripts/verify-avatar-network.mjs --allow-service-test [--linux-browser] [--peer] [--base-url http://localhost:3080] [--storage-state FILE] [--compose-project NAME] [--output temp/FILE.json]\n");
} else {
  await main().catch(() => { process.stderr.write("Avatar network verification could not start.\n"); process.exitCode = 1; });
}

async function main() {
  assert.ok(values["allow-service-test"], "An explicit service-test flag is required");
  const target = new URL(values["base-url"]);
  assert.ok(["http:", "https:"].includes(target.protocol) && ["localhost", "127.0.0.1", "[::1]"].includes(target.hostname) &&
    target.port === "3080" && !target.username && !target.password && target.pathname === "/" && !target.search && !target.hash,
  "Use the local application origin on port 3080");
  if (values.peer) assert.ok(values["linux-browser"], "Peer verification requires the isolated Linux browser");
  if (values["linux-browser"]) assert.equal(target.protocol, "http:", "The internal Linux tunnel verifies the local HTTP listener");
  const output = path.resolve(values.output);
  assert.ok(output.startsWith(path.resolve("temp") + path.sep), "Reports must stay inside temp");
  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(output, "{}\n", { flag: "wx", mode: 0o600 });
  const report = {
    kind: "avatar-network-verification", version: 3, status: "running", at: new Date().toISOString(), targetOrigin: target.origin,
    harnessSha256: createHash("sha256").update(await readFile(new URL(import.meta.url)))
      .update(await readFile(new URL("./avatar-network-browser.mjs", import.meta.url)))
      .update(await readFile(new URL("./avatar-network-linux.mjs", import.meta.url)))
      .update(await readFile(new URL("./avatar-network-peer.mjs", import.meta.url))).digest("hex"),
    methodology: {
      renderer: "Only user.image/name in GET /api/boards/<new fixture>/session is replaced in the browser response; server authentication, board, ACL and connection fields remain genuine",
      scope: "Self-avatar uses the substituted fixture session; optional peer mode uses genuine owner/guest sessions and WS, without response substitution",
      network: "Every HTTP(S) origin other than the selected local origin is intercepted and aborted before network access; attempted requests still fail acceptance",
      api: "Real update-user requests use a newly created anonymous test session, with before/after profile comparison; these API cases have no direct DB writes",
      peer: values.peer ? "Only a new anonymous fixture row receives parameterized legacy image seeds, guarded by id/isAnonymous/unique run name/expected image; original image restored independently" : "Not requested; binary peer unit coverage is separate",
    },
    browserCases: [], apiCases: [], foreignRequests: [], pageErrors: [], routeFailures: [], cleanup: [],
  };
  let owner;
  let browser;
  let guest;
  let boardId;
  let interrupted = false;
  const controller = new AbortController();
  const interrupt = () => {
    interrupted = true;
    controller.abort();
    void browser?.close().catch(() => undefined);
  };
  const signals = ["SIGINT", "SIGTERM", "SIGHUP"];
  signals.forEach((signal) => process.on(signal, interrupt));
  const timer = setTimeout(interrupt, 180_000);
  timer.unref();
  try {
    report.projectBinding = await inspectProject(values["compose-project"]);
    report.services = await dockerEnvironment(values["compose-project"]);
    owner = await ownerContext(target.origin, values["storage-state"]);
    const originalOwner = (await api(owner, "GET", "/api/auth/get-session")).user;
    boardId = await createBoard(owner, `Avatar network proof ${randomUUID()}`);
    const assetPath = await imageAsset(owner, boardId);
    const cases = [
      { name: "legacy-https", image: "https://avatar-network.invalid/legacy.png", allowed: false },
      { name: "legacy-http", image: "http://avatar-network.invalid/legacy.png", allowed: false },
      { name: "legacy-protocol-relative", image: "//avatar-network.invalid/legacy.png", allowed: false },
      { name: "bundled-svg", image: "/avatars/avatar_0.svg", allowed: true },
      { name: "local-asset", image: assetPath, allowed: true, expectedWidth: 24 },
    ];
    const storageState = await owner.storageState();
    if (values["linux-browser"]) {
      const result = await linuxAvatarCases({ projectBinding: report.projectBinding, storageState, boardId,
        ownerId: originalOwner.id, origin: target.origin, cases, signal: controller.signal, cleanup: report.cleanup });
      report.browserRuntime = "isolated-linux-container";
      report.browserVersion = result.browserVersion;
      report.browserContainer = result.container;
      for (const key of ["browserCases", "foreignRequests", "pageErrors", "routeFailures", "cleanup"]) report[key].push(...result[key]);
      if (result.status !== "complete") throw fail(`Linux avatar browser check failed (${result.errorKind ?? "unknown"})`);
    } else {
      report.browserRuntime = "host-chromium";
      browser = await chromium.launch({ channel: "chromium", headless: true,
        handleSIGINT: false, handleSIGTERM: false, handleSIGHUP: false });
      report.browserVersion = browser.version();
      for (const entry of cases) {
        if (interrupted) throw fail("Avatar verification interrupted");
        report.browserCases.push(await avatarBrowserCase(browser, { boardId, ownerId: originalOwner.id,
          origin: target.origin, entry, storageState, report }));
        await writeReport(output, report, true);
      }
    }
    guest = await request.newContext({ baseURL: target.origin, timeout: 15_000, extraHTTPHeaders: { origin: target.origin } });
    await api(guest, "POST", "/api/auth/sign-in/anonymous", {});
    const before = (await api(guest, "GET", "/api/auth/get-session")).user;
    assert.equal(before.isAnonymous, true);
    report.anonymousFixture = { created: true, userRetainedByServicePolicy: true, sessionSignOutRequired: true };
    for (const image of cases.filter((entry) => !entry.allowed)) {
      if (interrupted) throw fail("Avatar verification interrupted");
      const response = await guest.post("/api/auth/update-user", { data: { image: image.image } });
      const after = (await api(guest, "GET", "/api/auth/get-session")).user;
      report.apiCases.push({ name: image.name, status: response.status(), userUnchanged: after.id === before.id &&
        (after.image ?? null) === (before.image ?? null) && after.name === before.name });
    }
    if (values.peer) await verifyAvatarPeers({ owner, projectBinding: report.projectBinding, services: report.services,
      boardId, ownerId: originalOwner.id, assetPath, origin: target.origin, signal: controller.signal, report });
    const afterOwner = (await api(owner, "GET", "/api/auth/get-session")).user;
    report.ownerProfileUnchanged = afterOwner.id === originalOwner.id && afterOwner.name === originalOwner.name &&
      (afterOwner.image ?? null) === (originalOwner.image ?? null);
    report.criteria = {
      allBrowserCasesCompleted: report.browserCases.length === cases.length,
      unsafeAvatarsUseInitials: report.browserCases.filter((entry) => !entry.allowed).length === 3 &&
        report.browserCases.filter((entry) => !entry.allowed).every((entry) => entry.initialsVisible && entry.renderedImages === 0),
      localAvatarsDecoded: report.browserCases.filter((entry) => entry.allowed).length === 2 &&
        report.browserCases.filter((entry) => entry.allowed).every((entry) => entry.decoded && entry.localImageRequests > 0),
      noForeignBrowserRequests: report.foreignRequests.length === 0,
      noRoutingFailures: report.routeFailures.length === 0,
      realApiRejectsUnsafeImages: report.apiCases.length === 3 && report.apiCases.every((entry) => entry.status === 400 && entry.userUnchanged),
      ownerProfileUnchanged: report.ownerProfileUnchanged,
      noPageErrors: report.pageErrors.length === 0,
      ...(values.peer ? {
        threeRealPeerCasesCompleted: report.peer?.browserCases.length === 3,
        peerSessionsAndWsConfirmed: report.peer?.browserCases.length === 3 && report.peer.browserCases.every((entry) =>
          entry.ownerSessionConfirmed && entry.guestSessionConfirmed && entry.ownerWsFramesReceived > 0 && entry.guestWsFramesReceived > 0 &&
          entry.peerVisible && entry.responsesSubstituted === false),
        unsafePeerUsesInitials: report.peer?.browserCases.filter((entry) => !entry.allowed).length === 1 &&
          report.peer.browserCases.filter((entry) => !entry.allowed).every((entry) => entry.peerInitialsVisible && entry.peerRenderedImages === 0),
        localPeerAvatarsDecoded: report.peer?.browserCases.filter((entry) => entry.allowed).length === 2 &&
          report.peer.browserCases.filter((entry) => entry.allowed).every((entry) => entry.peerDecoded && entry.peerRenderedImages === 1 && entry.ownerLocalImageRequests > 0),
        peerOwnershipGuardsVerified: report.peer?.wrongIdAndNameGuardsRejected === true,
        peerOriginalImageRestored: report.peer?.profileRestored === true && report.peer.privateRecoveryRetained === false,
      } : {}),
    };
    report.status = Object.values(report.criteria).every(Boolean) ? "accepted" : "not-accepted";
  } catch (error) {
    report.status = interrupted ? "interrupted" : "failed";
    report.error = safeError(error);
  } finally {
    const cleanup = async (step, operation) => {
      try { await operation(); report.cleanup.push({ step, status: "complete" }); }
      catch { report.cleanup.push({ step, status: "failed" }); }
    };
    if (browser) await cleanup("close-browser", () => browser.close());
    if (guest) {
      await cleanup("sign-out-anonymous-session", () => api(guest, "POST", "/api/auth/sign-out", {}));
      await cleanup("dispose-anonymous-api", () => guest.dispose());
    }
    if (owner && boardId) await cleanup("remove-fixture-board-and-assets", async () => {
      await api(owner, "DELETE", `/api/boards/${boardId}`);
      assert.equal((await owner.get(`/api/boards/${boardId}`)).status(), 404);
    });
    if (owner) await cleanup("dispose-owner-api", () => owner.dispose());
    clearTimeout(timer);
    signals.forEach((signal) => process.off(signal, interrupt));
    if (report.cleanup.some((entry) => entry.status !== "complete")) report.status = "cleanup-failed";
    if (interrupted && report.status !== "cleanup-failed") report.status = "interrupted";
    if (report.status !== "accepted") process.exitCode = 1;
    await writeReport(output, report);
  }
}
