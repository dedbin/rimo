import { createEncoder, toUint8Array, writeVarString, writeVarUint } from "lib0/encoding";

import { fail } from "../common.mjs";

export async function instrument(page) {
  await page.addInitScript(() => {
    const sockets = new Set();
    window.__rimoNetwork = { sockets, pointerUpAt: null, receivedAt: null };
    const NativeWebSocket = window.WebSocket;
    window.WebSocket = class extends NativeWebSocket {
      constructor(...args) {
        super(...args);
        this.addEventListener("open", () => sockets.add(this));
        this.addEventListener("close", () => sockets.delete(this));
      }
    };
    window.addEventListener("pointerup", () => { window.__rimoNetwork.pointerUpAt = performance.timeOrigin + performance.now(); }, true);
  });
}

export async function collaborationRoundTrip(page, boardId) {
  const encoder = createEncoder();
  writeVarString(encoder, boardId);
  writeVarUint(encoder, 5);
  writeVarString(encoder, JSON.stringify({ type: "persistence-status" }));
  return page.evaluate((bytes) => new Promise((resolve, reject) => {
    const socket = [...window.__rimoNetwork.sockets].find((item) => item.readyState === WebSocket.OPEN);
    if (!socket) { reject(new Error("No collaboration socket")); return; }
    const start = performance.now();
    const timer = setTimeout(() => { socket.removeEventListener("message", receive); reject(new Error("Collaboration round trip timed out")); }, 5_000);
    const receive = (event) => {
      if (!(event.data instanceof ArrayBuffer)) return;
      const data = new Uint8Array(event.data);
      let index = 0;
      const integer = () => {
        let value = 0; let multiplier = 1;
        for (let count = 0; count < 5; count += 1) {
          const byte = data[index++];
          if (byte === undefined) throw new Error("Invalid protocol");
          value += (byte & 127) * multiplier;
          if (byte < 128) return value;
          multiplier *= 128;
        }
        throw new Error("Invalid protocol");
      };
      const string = () => { const length = integer(); const value = new TextDecoder().decode(data.subarray(index, index + length)); index += length; return value; };
      try {
        string();
        if (integer() !== 5 || JSON.parse(string()).type !== "persisted") return;
        clearTimeout(timer); socket.removeEventListener("message", receive); resolve(performance.now() - start);
      } catch { /* Only the expected bounded stateless response completes this timing. */ }
    };
    socket.addEventListener("message", receive);
    socket.send(new Uint8Array(bytes));
  }), [...toUint8Array(encoder)]);
}

export async function waitUntilUsable(page, count) {
  await page.getByText("Сохранено", { exact: true }).waitFor({ timeout: 30_000 });
  await page.locator('button:has(svg[class*="mouse-pointer"])').waitFor({ state: "visible" });
  await page.waitForFunction((expected) => {
    const camera = document.querySelector('svg[aria-label="Холст доски"] > g[style*="scale"]');
    if (!camera) return false;
    // Canvas renders stored layers, then one transform preview, then presence.
    // Remote transforms belong to the earlier layer wrappers and remain layers.
    const groups = [...camera.children].filter((item) => item.localName === "g" && item.getAttribute("aria-hidden") !== "true");
    const preview = groups.at(-1);
    if (!preview?.hasAttribute("transform")) return false;
    const layers = groups.slice(0, -1);
    return layers.length === expected && layers.every((group) => group.childElementCount === 1 &&
      ["rect", "ellipse", "path", "foreignObject"].includes(group.firstElementChild.localName));
  }, count);
  await page.evaluate(() => document.fonts.ready);
  const fontsFailed = await page.evaluate(() => [...document.fonts].some((face) => face.status === "error"));
  if (fontsFailed) throw fail("A visible board font failed to load");
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

export async function imagesReady(page, assetUrl, count) {
  await page.waitForFunction(({ expected, count }) => {
    const images = [...document.querySelectorAll('svg[aria-label="Холст доски"] img')]
      .filter((image) => new URL(image.currentSrc || image.src, location.href).pathname === expected);
    return images.length === count && images.every((image) => image.complete && image.naturalWidth > 0);
  }, { expected: assetUrl, count }, { timeout: 15_000 });
  await page.evaluate(async (assetUrl) => {
    await document.fonts.ready;
    await Promise.all([...document.querySelectorAll('svg[aria-label="Холст доски"] img')]
      .filter((image) => new URL(image.currentSrc || image.src, location.href).pathname === assetUrl).map((image) => image.decode()));
  }, assetUrl);
}

export async function measureMove(source, destination, position, dx) {
  const bounds = await source.locator('svg[aria-label="Холст доски"]').boundingBox();
  if (!bounds) throw fail("The fixture canvas is not visible");
  const start = { x: bounds.x + position.x + 13, y: bounds.y + position.y + 11 };
  await destination.evaluate(({ x, y, nextX }) => {
    window.__rimoNetwork.receivedAt = null;
    window.__rimoNetwork.observer?.disconnect();
    const element = [...document.querySelectorAll('svg[aria-label="Холст доски"] rect.drop-shadow-md')]
      .find((item) => { const matrix = new DOMMatrix(item.style.transform); return matrix.e === x && matrix.f === y; });
    if (!element) throw new Error("Fixture rectangle is missing");
    const observer = new MutationObserver(() => {
      const matrix = new DOMMatrix(element.style.transform);
      if (matrix.e === nextX && matrix.f === y) { window.__rimoNetwork.receivedAt = performance.timeOrigin + performance.now(); observer.disconnect(); }
    });
    observer.observe(element, { attributes: true, attributeFilter: ["style"] });
    window.__rimoNetwork.observer = observer;
  }, { ...position, nextX: position.x + dx });
  const isRectangle = await source.evaluate((point) => document.elementFromPoint(point.x, point.y)?.matches("rect.drop-shadow-md"), start);
  if (!isRectangle) throw fail("The fixture rectangle is covered by an editor overlay");
  await source.mouse.move(start.x, start.y);
  await source.mouse.down();
  await source.mouse.move(start.x + dx, start.y, { steps: 6 });
  await source.mouse.up();
  await destination.waitForFunction(() => window.__rimoNetwork.receivedAt !== null, undefined, { timeout: 10_000 });
  const [sent, received] = await Promise.all([
    source.evaluate(() => window.__rimoNetwork.pointerUpAt), destination.evaluate(() => window.__rimoNetwork.receivedAt),
  ]);
  if (!sent || !received || received < sent) throw fail("Invalid browser clock ordering");
  return received - sent;
}
