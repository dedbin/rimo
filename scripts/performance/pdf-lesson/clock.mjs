/** Runner/browser monotonic epoch; worker clocks are never used for occupancy. */
export const hostNow = () => performance.timeOrigin + performance.now();

/** Echo bounds never use Date.now(); wall time is diagnostic even when a VM adjusts it. */
export function clockBounds(echoes) {
  if (!echoes.length) throw new Error("No clock observations");
  const valid = echoes.every((entry, index) => [entry.sentAt, entry.receivedAt, entry.probeAt].every(Number.isFinite) &&
    entry.receivedAt >= entry.sentAt && (index === 0 || entry.sentAt >= echoes[index - 1].receivedAt && entry.probeAt >= echoes[index - 1].probeAt));
  const lower = valid ? Math.max(...echoes.map((entry) => entry.sentAt - entry.probeAt - 1)) : Number.NaN;
  const upper = valid ? Math.min(...echoes.map((entry) => entry.receivedAt - entry.probeAt + 1)) : Number.NaN;
  const uncertaintyMs = upper - lower;
  return { lower, upper, uncertaintyMs, stable: valid && Number.isFinite(uncertaintyMs) && lower <= upper && uncertaintyMs <= 50, observations: echoes.length };
}

export function browserClockCompatible(bounds) {
  return bounds?.stable === true && [bounds.lower, bounds.upper, bounds.uncertaintyMs].every(Number.isFinite) &&
    bounds.uncertaintyMs >= 0 && bounds.uncertaintyMs <= 50 &&
    bounds.lower >= -5 && bounds.upper <= 5 && bounds.lower <= bounds.upper;
}

/** Three short CDP echoes run before/after input, outside the pointerup timing. */
export async function browserClock(page, previous = []) {
  const echoes = [...previous];
  for (let index = 0; index < 3; index += 1) {
    const sentAt = hostNow(); const sentWallEpochMs = Date.now();
    const value = await page.evaluate(() => ({ at: performance.timeOrigin + performance.now(), wallEpochMs: Date.now() }));
    echoes.push({ sentAt, receivedAt: hostNow(), probeAt: value.at,
      sentWallEpochMs, receivedWallEpochMs: Date.now(), probeWallEpochMs: value.wallEpochMs });
  }
  return echoes;
}
