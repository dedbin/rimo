import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { request } from "playwright";

import { linuxAvatarCases } from "./avatar-network-linux.mjs";
import { api, fail, writeReport } from "./performance/common.mjs";
import { createDockerRunner } from "./tls-acceptance/run.mjs";

const mutate = String.raw`
(async()=>{
  const assert=require('node:assert/strict');
  const {getPool}=require('./server/db.ts');
  const parts=[];for await(const part of process.stdin)parts.push(part);
  const value=JSON.parse(Buffer.concat(parts).toString('utf8'));
  assert.match(value.id,/^[a-f0-9-]{36}$/);
  assert.match(value.name,/^Avatar peer [a-f0-9-]{36}$/);
  const pool=getPool();
  try{
    const result=await pool.query('UPDATE "user" SET image=$1 WHERE id=$2 AND "isAnonymous"=true AND name=$3 AND (image IS NOT DISTINCT FROM $4 OR image IS NOT DISTINCT FROM $5) RETURNING id',
      [value.image,value.id,value.name,value.expectedBefore,value.expectedAfter]);
    assert.equal(result.rowCount,value.expectedMatched);
    process.stdout.write(JSON.stringify({matched:result.rowCount}));
  }finally{await pool.end();}
})().catch(()=>{process.exitCode=1;});
`;

async function selectedApp(docker, project, services) {
  const ids = (await docker(["ps", "--quiet", "--no-trunc", "--filter", `label=com.docker.compose.project=${project}`,
    "--filter", "label=com.docker.compose.service=app"])).trim().split(/\r?\n/).filter(Boolean);
  assert.equal(ids.length, 1);
  assert.match(ids[0], /^[a-f0-9]{64}$/);
  const identity = JSON.parse(await docker(["inspect", "--format",
    '{"project":{{json (index .Config.Labels "com.docker.compose.project")}},"service":{{json (index .Config.Labels "com.docker.compose.service")}},"name":{{json .Name}},"image":{{json .Image}}}', ids[0]]));
  assert.equal(identity.project, project);
  assert.equal(identity.service, "app");
  assert.equal(services.containers.find((entry) => entry.name === identity.name)?.imageId, identity.image);
  return ids[0];
}

/** The only direct DB changes are guarded writes to this run's newly created anonymous fixture. */
export async function verifyAvatarPeers({ owner, projectBinding, services, boardId, ownerId, assetPath, origin, signal, report }) {
  const runId = randomUUID();
  const name = `Avatar peer ${runId}`;
  const docker = createDockerRunner({ ...process.env }, signal, () => undefined);
  const recoveryFile = path.resolve("temp/avatar-network", `private-peer-recovery-${runId}.json`);
  let guest;
  let invitation;
  let fixture;
  let appId;
  let recoveryCreated = false;
  let expectedBefore;
  let expectedAfter;
  let originalImage;
  report.peer = { requested: true, browserCases: [], profileRestored: false, anonymousUserRetainedByServicePolicy: true };
  const change = async (image, before, after, cleanup = false, expectedMatched = 1, guardFixture = fixture) => {
    const result = await docker(["exec", "-i", appId, "node", "--import=tsx", "-e", mutate], {
      cleanup, timeout: 30_000, input: Buffer.from(JSON.stringify({ ...guardFixture, image, expectedBefore: before, expectedAfter: after, expectedMatched })),
    });
    assert.equal(JSON.parse(result).matched, expectedMatched);
  };
  const cleanup = async (step, operation) => {
    try { await operation(); report.cleanup.push({ step, status: "complete" }); }
    catch { report.cleanup.push({ step, status: "failed" }); }
  };
  try {
    guest = await request.newContext({ baseURL: origin, timeout: 15_000, extraHTTPHeaders: { origin } });
    await api(guest, "POST", "/api/auth/sign-in/anonymous", {});
    const before = (await api(guest, "GET", "/api/auth/get-session")).user;
    assert.equal(before.isAnonymous, true);
    assert.notEqual(before.id, ownerId);
    invitation = await api(owner, "POST", `/api/boards/${boardId}/invites`, { role: "viewer", expiresInHours: 1 });
    await api(guest, "POST", "/api/invites/accept", { token: invitation.token, name });
    const verified = (await api(guest, "GET", "/api/auth/get-session")).user;
    assert.equal(verified.id, before.id);
    assert.equal(verified.name, name);
    assert.equal(verified.isAnonymous, true);
    fixture = { id: verified.id, name };
    originalImage = verified.image ?? null;
    expectedBefore = originalImage;
    expectedAfter = originalImage;
    appId = await selectedApp(docker, projectBinding.project, services);
    const recovery = { runId, project: projectBinding.project, appId, boardId, fixture, originalImage, expectedBefore, expectedAfter };
    await mkdir(path.dirname(recoveryFile), { recursive: true });
    await writeFile(recoveryFile, JSON.stringify(recovery), { flag: "wx", mode: 0o600 });
    recoveryCreated = true;
    // These harmless original-image writes must match no row when either fixture guard is wrong.
    await change(originalImage, originalImage, originalImage, false, 0, { ...fixture, id: randomUUID() });
    await change(originalImage, originalImage, originalImage, false, 0, { ...fixture, name: `Avatar peer ${randomUUID()}` });
    report.peer.wrongIdAndNameGuardsRejected = true;
    const cases = [
      { name: "peer-legacy-https", image: "https://avatar-network.invalid/legacy-peer.png", allowed: false },
      { name: "peer-bundled-svg", image: "/avatars/avatar_0.svg", allowed: true },
      { name: "peer-local-asset", image: assetPath, allowed: true, expectedWidth: 24 },
    ];
    let current = originalImage;
    const storageState = await owner.storageState();
    const guestStorageState = await guest.storageState();
    for (const entry of cases) {
      signal.throwIfAborted();
      expectedBefore = current;
      expectedAfter = entry.image;
      // Record both possible outcomes before a command whose response could be lost.
      await writeReport(recoveryFile, { ...recovery, expectedBefore, expectedAfter }, true);
      await change(entry.image, current, current);
      current = entry.image;
      const result = await linuxAvatarCases({ projectBinding, storageState, guestStorageState, guestId: fixture.id, guestName: name,
        boardId, ownerId, origin, cases: [entry], mode: "peer", signal, cleanup: report.cleanup });
      report.peer.browserCases.push(...result.browserCases);
      if (result.status !== "complete") report.peer.failedObservations = result.peerObservations;
      for (const key of ["foreignRequests", "pageErrors", "routeFailures", "cleanup"]) report[key].push(...result[key]);
      if (result.status !== "complete") throw fail(`Linux peer browser check failed (${result.errorKind ?? "unknown"})`);
      if (report.cleanup.some((item) => item.status !== "complete")) throw fail("Peer browser cleanup failed");
    }
  } finally {
    if (recoveryCreated) await cleanup("restore-owned-peer-original-image", async () => {
      await change(originalImage, expectedBefore, expectedAfter, true);
      const restored = (await api(guest, "GET", "/api/auth/get-session")).user;
      assert.equal(restored.id, fixture.id);
      assert.equal(restored.isAnonymous, true);
      assert.equal(restored.name, fixture.name);
      assert.equal(restored.image ?? null, originalImage);
      report.peer.profileRestored = true;
    });
    if (invitation?.invite?.id) await cleanup("revoke-owned-peer-invite", () => api(owner, "DELETE", `/api/boards/${boardId}/invites/${invitation.invite.id}`));
    if (fixture) await cleanup("revoke-owned-peer-membership", () => api(owner, "DELETE", `/api/boards/${boardId}/members/${fixture.id}`));
    if (guest) {
      await cleanup("sign-out-owned-peer-session", () => api(guest, "POST", "/api/auth/sign-out", {}));
      await cleanup("dispose-owned-peer-api", () => guest.dispose());
    }
    if (recoveryCreated && report.peer.profileRestored && report.cleanup.every((entry) => entry.status === "complete")) {
      await cleanup("remove-private-peer-recovery", () => rm(recoveryFile));
    }
    report.peer.privateRecoveryRetained = recoveryCreated && (!report.peer.profileRestored || report.cleanup.some((entry) => entry.status !== "complete"));
  }
}
