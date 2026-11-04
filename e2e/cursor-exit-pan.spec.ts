import type { Page } from "@playwright/test";

import { LayerType } from "../types/board-canvas";
import type { PathLayer, Point } from "../types/board-canvas";

import { canvas, openBoard, saved } from "./board-ui";
import { autoPan, camera, centerMouse, expectIdle, expectMotion, layers, observeCamera,
  screenCenter, selectedLayers } from "./cursor-edge-pan-ui";
import { expect, test } from "./fixtures";

interface Exit { name: string; point: Point; direction: Point }

async function focusBoard(page: Page, id: string): Promise<void> {
  await openBoard(page, id);
  await page.bringToFront();
  await expect.poll(() => page.evaluate(() => document.hasFocus())).toBe(true);
  await expect(autoPan(page)).toHaveAttribute("aria-pressed", "true");
  await centerMouse(page);
}

async function exits(page: Page): Promise<Exit[]> {
  const viewport = page.viewportSize();
  if (!viewport) throw new Error("Cursor exit tests require a fixed viewport");
  return [
    { name: "right", point: { x: viewport.width + 100, y: viewport.height / 2 }, direction: { x: -1, y: 0 } },
    { name: "bottom", point: { x: viewport.width / 2, y: viewport.height + 100 }, direction: { x: 0, y: -1 } },
    { name: "left", point: { x: -100, y: viewport.height / 2 }, direction: { x: 1, y: 0 } },
    { name: "top", point: { x: viewport.width / 2, y: -100 }, direction: { x: 0, y: 1 } },
  ];
}

test.beforeEach(({ browserName }) => {
  test.skip(browserName !== "chromium", "Focus and native out-of-viewport input are verified in Chromium");
});

test("a fast center-to-exit mouse move keeps scrolling outside every focused boundary", async ({ page, scenario }) => {
  await focusBoard(page, await scenario.createBoard("E2E автопрокрутка: выход за окно"));
  for (const exit of await exits(page)) await test.step(exit.name, async () => {
    await page.bringToFront();
    await centerMouse(page);
    const initial = await camera(page);
    // One native event jumps directly beyond the viewport, without visiting its edge band.
    await page.mouse.move(exit.point.x, exit.point.y, { steps: 1 });
    await expect.poll(() => page.evaluate(() => document.hasFocus())).toBe(true);
    await expectMotion(page, initial, exit.direction, 80);
    const outside = await observeCamera(page);
    const distance = Math.hypot(outside.last.x - outside.first.x, outside.last.y - outside.first.y);
    expect(distance, "A stationary cursor outside the focused window keeps scrolling").toBeGreaterThan(30);
    expect(distance).toBeLessThanOrEqual(480 * outside.elapsed / 1000 + 5);
    expect(outside.last.scale).toBe(initial.scale);
    const perpendicular = exit.direction.x ? outside.last.y - outside.first.y : outside.last.x - outside.first.x;
    expect(Math.abs(perpendicular)).toBeLessThan(1);
    await centerMouse(page);
    await expectIdle(page);
  });
  await expect(layers(page)).toHaveCount(0);
  await expect(page.getByRole("button", { name: /^Отменить/ })).toBeDisabled();
});

test("real window blur stops outside scrolling and focus alone does not restart it", async ({ page, scenario, context }) => {
  const other = await context.newPage();
  const sessions = await Promise.all([context.newCDPSession(page), context.newCDPSession(other)]);
  try {
    // Playwright forces every Chromium page to appear focused by default.
    // Cross-origin navigation may create a renderer and reapply that override.
    await focusBoard(page, await scenario.createBoard("E2E автопрокрутка: фокус окна"));
    await Promise.all(sessions.map((session) => session.send("Emulation.setFocusEmulationEnabled", { enabled: false })));
    await page.bringToFront();
    await expect.poll(() => page.evaluate(() => document.hasFocus()), { timeout: 2000 }).toBe(true);
    const [right] = await exits(page);
    const initial = await camera(page);
    await page.mouse.move(right.point.x, right.point.y, { steps: 1 });
    await expectMotion(page, initial, right.direction, 80);
    await other.bringToFront();
    await expect.poll(() => other.evaluate(() => document.hasFocus()), { timeout: 2000 }).toBe(true);
    await expect.poll(() => page.evaluate(() => document.hasFocus()), { timeout: 2000 }).toBe(false);
    const blurred = await camera(page);
    // The board's RAF may be suspended in a background tab; observe elapsed time in the foreground instead.
    await other.waitForTimeout(240);
    expect(await camera(page)).toEqual(blurred);
    await page.bringToFront();
    await expect.poll(() => page.evaluate(() => document.hasFocus()), { timeout: 2000 }).toBe(true);
    await expectIdle(page);
    expect(await camera(page)).toEqual(blurred);
    await centerMouse(page);
    const resumed = await camera(page);
    await page.mouse.move(right.point.x, right.point.y, { steps: 1 });
    await expectMotion(page, resumed, right.direction, 80);
    await centerMouse(page);
    await expectIdle(page);
  } finally {
    const restored = await Promise.allSettled(sessions.map((session) =>
      session.send("Emulation.setFocusEmulationEnabled", { enabled: true })));
    const detached = await Promise.allSettled(sessions.map((session) => session.detach()));
    await other.close();
    expect.soft([...restored, ...detached].every((result) => result.status === "fulfilled"),
      "Chromium focus overrides are restored and protocol sessions are detached").toBe(true);
  }
  await expect(layers(page)).toHaveCount(0);
});

test("a captured marker stroke releases outside without a coordinate jump and undoes once", async ({ page, scenario }) => {
  await focusBoard(page, await scenario.createBoard("E2E автопрокрутка: штрих за окном"));
  await page.getByRole("button", { name: "Маркер", exact: true }).click();
  await centerMouse(page);
  const [right] = await exits(page);
  const initial = await camera(page);
  await page.mouse.down();
  let beforeRelease = initial;
  try {
    await page.mouse.move(right.point.x, right.point.y, { steps: 3 });
    await expectMotion(page, initial, right.direction, 120);
    await expect(layers(page)).toHaveCount(0);
    beforeRelease = await camera(page);
  } finally { await page.mouse.up(); }
  const afterRelease = await camera(page);
  await expectMotion(page, afterRelease, right.direction, 40);
  await centerMouse(page);
  await expectIdle(page);
  await expect(layers(page)).toHaveCount(1);
  await page.keyboard.press("Escape");
  await canvas(page).locator("[data-layer-id] path").click();
  const [stroke] = await selectedLayers(page) as PathLayer[];
  expect(stroke.type).toBe(LayerType.Path);
  const end = stroke.points.at(-1)!;
  const finalX = stroke.x + end[0];
  expect(finalX).toBeGreaterThanOrEqual((right.point.x - beforeRelease.x) / beforeRelease.scale - 20);
  expect(finalX).toBeLessThanOrEqual((right.point.x - afterRelease.x) / afterRelease.scale + 20);
  expect(stroke.y + end[1]).toBeCloseTo((right.point.y - initial.y) / initial.scale, 1);
  await page.getByRole("button", { name: /^Отменить/ }).click();
  await expect(layers(page)).toHaveCount(0);
  await expect(page.getByRole("button", { name: /^Отменить/ })).toBeDisabled();
  await page.getByRole("button", { name: /^Повторить/ }).click();
  await expect(layers(page)).toHaveCount(1);
  await saved(page);
});

test("a captured object drag keeps its anchor outside the window and commits one undoable move", async ({ page, scenario }) => {
  await focusBoard(page, await scenario.createBoard("E2E автопрокрутка: перенос за окном"));
  const [right] = await exits(page);
  await page.getByRole("button", { name: /^Прямоугольник/ }).click();
  await page.mouse.click(right.point.x - 400, right.point.y - 50);
  await page.keyboard.press("Escape");
  const shape = canvas(page).locator("[data-layer-id] > rect");
  await shape.click();
  const [original] = await selectedLayers(page);
  const origin = await screenCenter(shape);
  const initial = await camera(page);
  await page.mouse.move(origin.x, origin.y);
  await page.mouse.down();
  let beforeRelease = initial;
  try {
    await page.mouse.move(right.point.x, right.point.y, { steps: 1 });
    await expectMotion(page, initial, right.direction, 120);
    await expect.poll(async () => {
      const center = await screenCenter(shape);
      return Math.hypot(center.x - right.point.x, center.y - right.point.y);
    }).toBeLessThan(3);
    beforeRelease = await camera(page);
  } finally { await page.mouse.up(); }
  const afterRelease = await camera(page);
  await centerMouse(page);
  await expectIdle(page);
  const [moved] = await selectedLayers(page);
  expect(moved.x).toBeGreaterThan(original.x + 300);
  const finalCenterX = moved.x + moved.width / 2;
  expect(finalCenterX).toBeGreaterThanOrEqual((right.point.x - beforeRelease.x) / beforeRelease.scale - 20);
  expect(finalCenterX).toBeLessThanOrEqual((right.point.x - afterRelease.x) / afterRelease.scale + 20);
  expect(moved.y).toBeCloseTo(original.y, 1);
  await page.getByRole("button", { name: /^Отменить/ }).click();
  expect(await selectedLayers(page)).toEqual([original]);
  await page.getByRole("button", { name: /^Повторить/ }).click();
  expect(await selectedLayers(page)).toEqual([moved]);
  await saved(page);
});
