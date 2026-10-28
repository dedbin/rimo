import { createDecoder, readVarString, readVarUint } from "lib0/decoding";
import { HttpsProxyAgent } from "https-proxy-agent";
import { chromium, request } from "playwright";

import { describeClose, fail, openProvider } from "../common.mjs";
import { VIEWPORT } from "../fixture.mjs";
import { imagesReady, instrument, waitUntilUsable } from "../network/browser-probe.mjs";

export async function openNodeActor({ label, helper, baseURL, boardId, storageState, signal, onCreated }) {
  const agent = new HttpsProxyAgent(helper.proxy.server);
  const connectStatuses = [];
  let context; let peer; let closed = false; let closing; let failure;
  agent.on("proxyConnect", ({ statusCode }) => {
    connectStatuses.push(Number.isSafeInteger(statusCode) ? statusCode : null);
    if (statusCode !== 200) failure ??= "Node WebSocket CONNECT did not return 200";
  });
  const actor = {
    kind: "node", label, connectStatuses,
    get peer() { return peer; },
    get failure() { return failure ?? peer?.failure ?? null; },
    get connected() { return !closed && peer?.websocket.webSocket?.readyState === 1; },
    snapshot() { return { kind: "node", label, failure: actor.failure, closeEvent: peer?.closeEvent ?? null,
      connectStatuses: [...connectStatuses], wire: peer?.stats ?? null }; },
    async close() {
      if (closing) return closing;
      closed = true;
      closing = (async () => {
        const peerClosed = peer?.close(); // Marks SDK callbacks as deliberately closed before agent.destroy().
        agent.destroy();
        const results = await Promise.allSettled([peerClosed, context?.dispose()]);
        if (results.some((result) => result.status === "rejected")) throw fail("Node actor cleanup failed");
      })();
      return closing;
    },
  };
  try {
    onCreated(actor);
    signal.throwIfAborted();
    context = await request.newContext({ baseURL, storageState, proxy: helper.proxy, timeout: 15_000,
      extraHTTPHeaders: { origin: new URL(baseURL).origin } });
    if (closed || signal.aborted) { await context.dispose(); signal.throwIfAborted(); throw fail("Node actor already closed"); }
    peer = await openProvider(context, baseURL, boardId, signal, { agent });
    if (closed || signal.aborted) { await peer.close(); signal.throwIfAborted(); throw fail("Node actor already closed"); }
    const connection = new URL(peer.session.connection.url);
    if (connection.protocol !== "ws:" || connection.hostname !== "localhost" || connection.port !== "3080" ||
        connectStatuses.length !== 1 || connectStatuses[0] !== 200 || actor.failure) {
      throw fail("Node actor must use exactly one successful CONNECT to the local service");
    }
    return actor;
  } catch (error) { await actor.close(); throw error; }
}

export async function openBrowserActor({ label, helper, baseURL, boardId, storageState, assetUrl, signal, onCreated }) {
  let browser; let page; let closed = false; let closing; let failure;
  let pageErrorCount = 0; let openedSockets = 0; let closeEvent;
  const upgradeStatuses = [];
  const actor = {
    kind: "browser", label, upgradeStatuses,
    get page() { return page; },
    get failure() { return failure ?? null; },
    async connections() { return closed || !page ? 0 : page.evaluate(() => [...window.__rimoNetwork.sockets].filter((socket) => socket.readyState === 1).length); },
    snapshot() { return { kind: "browser", label, failure: actor.failure, pageErrorCount, openedSockets,
      closeEvent: closeEvent ?? null, upgradeStatuses: [...upgradeStatuses], version: browser?.version(), viewport: VIEWPORT }; },
    async close() {
      if (closing) return closing;
      closed = true;
      closing = browser?.close() ?? Promise.resolve();
      return closing;
    },
  };
  try {
    onCreated(actor);
    signal.throwIfAborted();
    browser = await chromium.launch({ channel: "chromium", headless: true, proxy: helper.proxy,
      handleSIGINT: false, handleSIGTERM: false, handleSIGHUP: false });
    if (closed || signal.aborted) { await browser.close(); signal.throwIfAborted(); throw fail("Browser actor already closed"); }
    const context = await browser.newContext({ storageState, viewport: VIEWPORT, deviceScaleFactor: 1, locale: "ru-RU" });
    context.setDefaultTimeout(15_000);
    page = await context.newPage();
    page.on("pageerror", () => { pageErrorCount += 1; if (!closed) failure ??= "Browser page error"; });
    page.on("websocket", (socket) => {
      openedSockets += 1;
      const connection = new URL(socket.url());
      if (connection.protocol !== "ws:" || connection.hostname !== "localhost" || connection.port !== "3080" || openedSockets !== 1) {
        failure ??= "Unexpected browser collaboration connection or reconnect";
      }
      socket.on("socketerror", () => { if (!closed) failure ??= "Browser WebSocket error"; });
      socket.on("close", () => { if (!closed) failure ??= "Browser collaboration connection closed"; });
      socket.on("framereceived", ({ payload }) => {
        if (closed) return;
        try {
          const decoder = createDecoder(typeof payload === "string" ? Buffer.from(payload) : payload);
          if (readVarString(decoder) !== boardId) return;
          const type = readVarUint(decoder);
          if (type === 7) {
            closeEvent ??= describeClose({ code: 1000, reason: readVarString(decoder) });
            failure ??= `Browser connection closed (${closeEvent.code}/${closeEvent.reason})`;
          }
          if (type === 5 && JSON.parse(readVarString(decoder)).type === "persistence-error") failure ??= "Browser received a persistence failure";
        } catch { /* Unsupported frames are not retained or printed. */ }
      });
    });
    await instrument(page);
    const cdp = await context.newCDPSession(page);
    cdp.on("Network.webSocketHandshakeResponseReceived", ({ response }) => {
      upgradeStatuses.push(response.status);
      if (response.status !== 101) failure ??= "Browser WebSocket upgrade did not return 101";
    });
    await cdp.send("Network.enable");
    await cdp.send("Network.setCacheDisabled", { cacheDisabled: true });
    await page.goto(`${baseURL}/board/${boardId}`, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await waitUntilUsable(page, 500);
    await imagesReady(page, assetUrl, 50);
    signal.throwIfAborted();
    if (actor.failure || await actor.connections() !== 1 || upgradeStatuses.length !== 1 || upgradeStatuses[0] !== 101) {
      throw fail("Browser actor must have one healthy proxied collaboration socket");
    }
    return actor;
  } catch (error) { await actor.close(); throw error; }
}

export function assertHealthy(actors) {
  const broken = actors.find((actor) => actor.failure);
  if (broken) throw fail(`${broken.label}: ${broken.failure}`);
  if (actors.some((actor) => actor.kind === "node" && !actor.connected)) throw fail("A Node collaboration connection is not open");
}

export async function browserCoordinates(page, targets) {
  await page.waitForFunction((expected) => {
    const positions = [...document.querySelectorAll('svg[aria-label="Холст доски"] rect.drop-shadow-md')]
      .map((element) => { const matrix = new DOMMatrix(element.style.transform); return { x: matrix.e, y: matrix.f }; });
    return expected.every(({ x, y }) => positions.some((position) => position.x === x && position.y === y));
  }, targets.map(({ x, y }) => ({ x, y })), { timeout: 20_000 });
}
