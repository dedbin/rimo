import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { promisify } from "node:util";
import { createEncoder, toUint8Array, writeVarString, writeVarUint } from "lib0/encoding";
import { chromium } from "playwright";
import { WebSocketServer } from "ws";

import { collaborationRoundTrip, instrument, measureMove, waitUntilUsable } from "./browser-probe.mjs";
import { cleanupStep, NETWORK_SELF_TEST_FILE, networkSourceHash, startHelper, writeNetworkReport } from "./helper.mjs";
import { createRunLifecycle } from "./lifecycle.mjs";

const boardId = "00000000-0000-0000-0000-000000000000";
const encoder = createEncoder(); writeVarString(encoder, boardId); writeVarUint(encoder, 5); writeVarString(encoder, JSON.stringify({ type: "persisted" }));
const acknowledgement = toUint8Array(encoder);
const html = `<!doctype html><style>body{margin:0}span,button{position:fixed;top:0}svg[aria-label]{position:absolute;inset:0}</style><span>Сохранено</span><button><svg class="mouse-pointer"></svg></button>
  <svg aria-label="Холст доски" width="1440" height="1000"><g style="transform:scale(1)"><g transform="translate(0 0)"><rect class="drop-shadow-md" width="26" height="22" fill="blue" style="transform:translate(300px,350px)"/></g>
  ${Array.from({ length: 499 }, () => '<g><rect class="drop-shadow-md" width="0" height="0"/></g>').join("")}
  <g transform="translate(20 0)"><rect class="drop-shadow-md" width="0" height="0"/></g>
  <rect class="pointer-events-none" width="0" height="0"/>
  <g aria-hidden="true" pointer-events="none"><path class="drop-shadow-md" d="M0 0L1 1"/><foreignObject width="30" height="20"><span>Peer cursor</span></foreignObject></g>
  </g></svg>
  <script>
    const socket = new WebSocket('ws://localhost:18991/echo'); socket.binaryType='arraybuffer';
    const rectangle = document.querySelector('rect'); let down;
    rectangle.addEventListener('pointerdown', event => { down = event.clientX; });
    window.addEventListener('pointerup', event => { if(down !== undefined) socket.send(JSON.stringify({x:300+event.clientX-down})); down=undefined; });
    socket.addEventListener('message', event => { if(typeof event.data === 'string') rectangle.style.transform='translate('+JSON.parse(event.data).x+'px,350px)'; });
  </script>`;
const server = createServer((_request, response) => { response.setHeader("Content-Type", "text/html; charset=utf-8"); response.end(html); });
const websocket = new WebSocketServer({ noServer: true });
server.on("upgrade", (request, socket, head) => websocket.handleUpgrade(request, socket, head, (peer) => {
  peer.on("message", (data, binary) => {
    if (binary) peer.send(acknowledgement);
    else for (const client of websocket.clients) if (client.readyState === 1) client.send(data, { binary: false });
  });
}));
const helpers = [];
const browsers = [];
const pages = [];
const report = { kind: "network-probe-self-test", status: "running", at: new Date().toISOString(), helperAttempts: [], helpers: [], cleanup: [] };
const lifecycle = createRunLifecycle(60_000, async () => {
  server.closeAllConnections(); websocket.clients.forEach((peer) => peer.terminate());
  await Promise.allSettled(browsers.map((browser) => browser.close()));
});
const save = () => writeNetworkReport(NETWORK_SELF_TEST_FILE, report);
try {
  report.networkSourceSha256 = await networkSourceHash();
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(18991, "127.0.0.1", resolve); });
  lifecycle.check();
  for (let index = 0; index < 2; index += 1) {
    lifecycle.check();
    const helper = await startHelper(async (descriptor) => { report.helperAttempts.push(descriptor); await save(); });
    helpers.push(helper); report.helpers.push(helper.metadata); lifecycle.check();
    await helper.configure([18991], 50);
    const browser = await chromium.launch({ channel: "chromium", headless: true, proxy: helper.proxy,
      handleSIGINT: false, handleSIGTERM: false, handleSIGHUP: false }); browsers.push(browser);
    lifecycle.check();
    report.browserVersion = browser.version();
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } }); pages.push(page);
    page.setDefaultTimeout(3_000);
    await instrument(page);
    await page.goto("http://localhost:18991", { waitUntil: "networkidle" });
    const rawGroups = await page.evaluate(() => [...document.querySelector('svg[aria-label="Холст доски"] > g').children]
      .filter((item) => item.localName === "g" && item.childElementCount > 0).length);
    assert.equal(rawGroups, 502, "Regression fixture must expose the former cursor/preview overcount");
    await waitUntilUsable(page, 500);
    report.phase = `browser-${index}-ready`; await save();
    process.stdout.write(`${JSON.stringify({ event: "self_test_progress", phase: report.phase })}\n`);
  }
  const roundtrip = await collaborationRoundTrip(pages[0], boardId);
  const propagation = await measureMove(pages[0], pages[1], { x: 300, y: 350 }, 20);
  assert.ok(roundtrip >= 90 && roundtrip < 200, "Round-trip timer is not measuring the shaped browser socket");
  assert.ok(propagation >= 90 && propagation < 250, "Pointer-up to DOM mutation timer is not measuring the shaped peer path");
  for (const browser of browsers) await browser.close();
  await promisify(execFile)("docker", ["rm", "--force", helpers[0].metadata.id], { windowsHide: true, timeout: 10_000 });
  await helpers[0].close(); await helpers[0].close();
  const cleanupReport = { cleanup: [] };
  assert.equal(await cleanupStep(cleanupReport, "intentional failure", () => { throw new Error("Expected cleanup regression"); }), false);
  assert.equal(await cleanupStep(cleanupReport, "next helper", () => helpers[1].close()), true);
  assert.equal(cleanupReport.cleanup[1].status, "complete");
  lifecycle.check();
  report.status = "complete";
  report.checks = { result: "passed", roundtripMs: roundtrip, pointerUpToPeerStyleMutationMs: propagation,
    clients: 2, rawNonEmptyCameraGroups: 502, acceptedViewportLayers: 500, alreadyRemovedAndRepeatedClosePassed: true,
    cleanupContinuedAfterFailure: true, fixture: "inert self-test, not Rimo acceptance" };
} catch (error) { report.status = "failed"; report.error = error instanceof Error ? error.message.split(/\r?\n/)[0] : "Self-test failed"; process.exitCode = 1; }
finally {
  const cleanup = async (step, operation) => { if (!await cleanupStep(report, step, operation)) { report.status = "failed"; process.exitCode = 1; } };
  await Promise.all(browsers.map((browser, index) => cleanup(`browser-${index}`, () => browser.close())));
  await Promise.all(helpers.map((helper, index) => cleanup(`owned helper-${index}`, () => helper.close())));
  await cleanup("echo websocket", async () => { websocket.clients.forEach((peer) => peer.terminate()); await new Promise((resolve) => websocket.close(resolve)); });
  await cleanup("echo HTTP", async () => { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); });
  lifecycle.apply(report);
  try { await lifecycle.finalize(report, save); process.stdout.write(`${JSON.stringify({ status: report.status, interruption: report.interruption, checks: report.checks })}\n`); }
  finally { lifecycle.dispose(); }
}
