import assert from "node:assert/strict";
import { createServer } from "node:http";
import { chromium } from "playwright";
import { WebSocketServer } from "ws";

import { cleanupStep, NETWORK_CALIBRATION_FILE, networkSourceHash, startHelper, writeNetworkReport } from "./helper.mjs";
import { createRunLifecycle } from "./lifecycle.mjs";

const server = createServer(async (request, response) => {
  try {
  const url = new URL(request.url, "http://localhost:18991");
  response.setHeader("Cache-Control", "no-store");
  if (url.pathname === "/bytes") {
    const size = Number(url.searchParams.get("size"));
    if (![8_388_608, 16_777_216].includes(size)) { response.writeHead(400).end(); return; }
    response.writeHead(200, { "Content-Length": String(size), "Content-Type": "application/octet-stream" });
    response.end(Buffer.alloc(size, 65));
  } else if (url.pathname === "/upload") {
    let bytes = 0;
    for await (const chunk of request) bytes += chunk.length;
    response.end(String(bytes));
  } else if (url.pathname === "/echo") response.end("ok");
  else { response.setHeader("Content-Type", "text/html"); response.end("<!doctype html><title>Network calibration</title>"); }
  } catch { response.destroy(); }
});
const websocket = new WebSocketServer({ noServer: true });
server.on("upgrade", (request, socket, head) => websocket.handleUpgrade(request, socket, head, (peer) => {
  peer.on("message", (data, binary) => peer.send(data, { binary }));
}));
const report = { kind: "network-calibration", at: new Date().toISOString(), status: "running", helperAttempts: [], phases: [], failedRequests: [], cleanup: [] };
let helper;
let browser;
const lifecycle = createRunLifecycle(180_000, async () => {
  server.closeAllConnections(); websocket.clients.forEach((peer) => peer.terminate());
  await browser?.close();
});
const save = () => writeNetworkReport(NETWORK_CALIBRATION_FILE, report);
try {
  report.networkSourceSha256 = await networkSourceHash();
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(18991, "127.0.0.1", resolve); });
  lifecycle.check();
  helper = await startHelper(async (descriptor) => { report.helperAttempts.push(descriptor); await save(); });
  report.helper = helper.metadata;
  lifecycle.check();
  for (const [name, latency] of [["proxy-no-added-latency", 0], ["proxy-added-100ms-roundtrip", 50]]) {
    lifecycle.check();
    await helper.configure([18991], latency);
    browser = await chromium.launch({ channel: "chromium", headless: true, proxy: helper.proxy,
      handleSIGINT: false, handleSIGTERM: false, handleSIGHUP: false });
    lifecycle.check();
    report.browserVersion = browser.version();
    const page = await browser.newPage();
    page.on("requestfailed", (request) => {
      if (report.failedRequests.length < 20) report.failedRequests.push({ resource: new URL(request.url()).pathname, error: request.failure()?.errorText });
    });
    await page.exposeFunction("recordCalibrationStage", async (step) => {
      report.phase = `${name}:${step}`; await save();
      process.stdout.write(`${JSON.stringify({ event: "calibration_progress", phase: report.phase })}\n`);
    });
    await page.goto("http://localhost:18991", { waitUntil: "networkidle" });
    const measured = await page.evaluate(async () => {
      await window.recordCalibrationStage("http-roundtrip");
      const http = [];
      for (let index = 0; index < 12; index += 1) {
        const start = performance.now();
        if (await fetch("/echo", { cache: "no-store" }).then((response) => response.text()) !== "ok") throw new Error("Echo mismatch");
        http.push(performance.now() - start);
      }
      await window.recordCalibrationStage("websocket-roundtrip");
      const ws = await new Promise((resolve, reject) => {
        const socket = new WebSocket("ws://localhost:18991/echo");
        const samples = [];
        let start;
        const timer = setTimeout(() => { socket.close(); reject(new Error("Echo timeout")); }, 10_000);
        socket.onerror = () => { clearTimeout(timer); reject(new Error("Echo failed")); };
        const send = () => { start = performance.now(); socket.send(String(samples.length)); };
        socket.onopen = send;
        socket.onmessage = (event) => {
          if (event.data !== String(samples.length)) { clearTimeout(timer); reject(new Error("Echo mismatch")); return; }
          samples.push(performance.now() - start);
          if (samples.length < 20) send();
          else { clearTimeout(timer); socket.close(); resolve(samples); }
        };
      });
      const transfer = async (connections, bytes, upload) => {
        await window.recordCalibrationStage(`${upload ? "upload" : "download"}-${connections}`);
        const start = performance.now();
        const sizes = await Promise.all(Array.from({ length: connections }, async () => {
          const response = await fetch(upload ? "/upload" : `/bytes?size=${bytes}`, { cache: "no-store",
            ...(upload ? { method: "POST", body: new Uint8Array(bytes) } : {}) });
          return upload ? Number(await response.text()) : (await response.arrayBuffer()).byteLength;
        }));
        if (sizes.some((size) => size !== bytes)) throw new Error("Transfer mismatch");
        const milliseconds = performance.now() - start;
        return { connections, bytes: bytes * connections, milliseconds, megabitsPerSecond: bytes * connections * 8 / milliseconds / 1000 };
      };
      return { httpRoundtripMs: http, websocketRoundtripMs: ws,
        downloadOne: await transfer(1, 16_777_216, false), downloadSix: await transfer(6, 8_388_608, false),
        uploadSix: await transfer(6, 8_388_608, true) };
    });
    const median = (values) => values.toSorted((a, b) => a - b)[Math.floor(values.length / 2)];
    report.phases.push({ name, latencyMsPerDirection: latency, ...measured,
      httpMedianMs: median(measured.httpRoundtripMs), websocketMedianMs: median(measured.websocketRoundtripMs), statistics: await helper.statistics() });
    await browser.close(); browser = undefined;
  }
  const [baseline, impaired] = report.phases;
  report.checks = {
    websocketDelayAdded: impaired.websocketMedianMs - baseline.websocketMedianMs >= 85 && impaired.websocketMedianMs - baseline.websocketMedianMs < 150,
    httpDelayAdded: impaired.httpMedianMs - baseline.httpMedianMs >= 85,
    oneAndSixConnectionsShareDownloadCap: report.phases.every((phase) => phase.downloadOne.megabitsPerSecond <= 55 && phase.downloadSix.megabitsPerSecond <= 55),
    sixConnectionsShareUploadCap: report.phases.every((phase) => phase.uploadSix.megabitsPerSecond <= 55),
  };
  assert.ok(Object.values(report.checks).every(Boolean), "Network calibration did not meet its checks");
  lifecycle.check();
  report.status = "complete";
} catch (error) { report.status = "failed"; report.error = error instanceof Error ? error.message.split(/\r?\n/)[0] : "Calibration failed"; process.exitCode = 1; }
finally {
  const cleanup = async (step, operation) => { if (!await cleanupStep(report, step, operation)) { report.status = "failed"; process.exitCode = 1; } };
  await cleanup("browser", () => browser?.close());
  await cleanup("owned helper", () => helper?.close());
  await cleanup("echo websocket", async () => { websocket.clients.forEach((peer) => peer.terminate()); await new Promise((resolve) => websocket.close(resolve)); });
  await cleanup("echo HTTP", async () => { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); });
  lifecycle.apply(report);
  try {
    await lifecycle.finalize(report, save);
    process.stdout.write(`${JSON.stringify({ status: report.status, interruption: report.interruption, error: report.error, checks: report.checks, phases: report.phases.map(({ name, httpMedianMs, websocketMedianMs, downloadOne, downloadSix, uploadSix }) => ({ name, httpMedianMs, websocketMedianMs, downloadOne, downloadSix, uploadSix })) })}\n`);
  } finally { lifecycle.dispose(); }
}
