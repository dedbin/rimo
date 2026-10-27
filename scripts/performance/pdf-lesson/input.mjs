import { fail } from "../common.mjs";
import { browserClock, clockBounds } from "./clock.mjs";

/** Prepare the real drag before the public PDF request; only pointerup waits for worker occupancy. */
export async function prepareMove(source, peer, position, dx) {
  const [sourceEchoes, peerEchoes] = await Promise.all([browserClock(source), browserClock(peer)]);
  const bounds = await source.locator('svg[aria-label="Холст доски"]').boundingBox();
  if (!bounds) throw fail("The fixture canvas is not visible");
  const start = { x: bounds.x + position.x + 13, y: bounds.y + position.y + 11 };
  await source.evaluate(() => { window.__rimoNetwork.pointerUpAt = null; });
  await peer.evaluate(({ x, y, nextX }) => {
    window.__rimoNetwork.receivedAt = null;
    window.__rimoNetwork.observer?.disconnect();
    const element = [...document.querySelectorAll('svg[aria-label="Холст доски"] rect.drop-shadow-md')]
      .find((item) => { const matrix = new DOMMatrix(item.style.transform); return matrix.e === x && matrix.f === y; });
    if (!element) throw new Error("Fixture rectangle is missing");
    const observer = new MutationObserver(() => {
      const matrix = new DOMMatrix(element.style.transform);
      if (matrix.e === nextX && matrix.f === y) {
        window.__rimoNetwork.receivedAt = performance.timeOrigin + performance.now(); observer.disconnect();
      }
    });
    observer.observe(element, { attributes: true, attributeFilter: ["style"] });
    window.__rimoNetwork.observer = observer;
  }, { ...position, nextX: position.x + dx });
  if (!await source.evaluate((point) => document.elementFromPoint(point.x, point.y)?.matches("rect.drop-shadow-md"), start)) {
    throw fail("The fixture rectangle is covered by an editor overlay");
  }
  await source.mouse.move(start.x, start.y);
  await source.mouse.down();
  await source.mouse.move(start.x + dx, start.y, { steps: 6 });
  return {
    async release() {
      await source.mouse.up();
      await peer.waitForFunction(() => window.__rimoNetwork.receivedAt !== null, undefined, { timeout: 10_000 });
    },
    async timing() {
      const [pointerUpAt, receivedAt, sourceAfter, peerAfter] = await Promise.all([
        source.evaluate(() => window.__rimoNetwork.pointerUpAt), peer.evaluate(() => window.__rimoNetwork.receivedAt),
        browserClock(source, sourceEchoes), browserClock(peer, peerEchoes),
      ]);
      const sourceClock = clockBounds(sourceAfter); const peerClock = clockBounds(peerAfter);
      const measured = Number.isFinite(pointerUpAt) && Number.isFinite(receivedAt);
      return { pointerUpAt, receivedAt, sourceClock, peerClock, browserClockEchoes: { source: sourceAfter, peer: peerAfter },
        rawPropagationMs: measured ? receivedAt - pointerUpAt : null,
        propagationMs: measured ? receivedAt + peerClock.upper - (pointerUpAt + sourceClock.lower) : null };
    },
  };
}
