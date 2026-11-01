import type { CDPSession, Locator, Page } from "@playwright/test";

import { canvas, invitation, openBoard, saved } from "./board-ui";
import { expect, test } from "./fixtures";

interface BoardView { centerX: number; centerY: number; scale: number }
interface TouchPoint { id: number; x: number; y: number }

const lasers = (page: Page): Locator => canvas(page).locator("[data-laser-id]");
const layers = (page: Page): Locator => canvas(page).locator("[data-layer-id]");
const stopFollowing = (page: Page): Locator => page.getByRole("button", { name: "Прекратить следование", exact: true });

async function camera(page: Page): Promise<BoardView> {
  return canvas(page).locator('[data-board-layers="true"]').evaluate((element) => {
    const matrix = new DOMMatrixReadOnly(getComputedStyle(element).transform);
    const svg = (element as SVGGElement).ownerSVGElement!;
    return { centerX: (svg.clientWidth / 2 - matrix.e) / matrix.a,
      centerY: (svg.clientHeight / 2 - matrix.f) / matrix.a, scale: matrix.a };
  });
}

async function cameraDifference(first: Page, second: Page): Promise<number> {
  const [a, b] = await Promise.all([camera(first), camera(second)]);
  return Math.max(Math.abs(a.centerX - b.centerX), Math.abs(a.centerY - b.centerY), Math.abs(a.scale - b.scale));
}

async function touch(session: CDPSession, type: "touchStart" | "touchMove" | "touchEnd" | "touchCancel", points: TouchPoint[]): Promise<void> {
  await session.send("Input.dispatchTouchEvent", { type,
    touchPoints: points.map((point) => ({ ...point, radiusX: 5, radiusY: 5, force: 0.5 })) });
}

test("following shares board center and zoom across viewports and stops on manual navigation or departure", async ({ page, scenario }) => {
  const boardId = await scenario.createBoard("E2E v0.3: следование");
  await openBoard(page, boardId);
  const leader = await scenario.guest(await invitation(page, "editor"), "Ведущий v0.3");
  await leader.setViewportSize({ width: 960, height: 720 });
  const follow = page.getByRole("button", { name: "Следовать за Ведущий v0.3", exact: true });
  await expect(follow).toBeEnabled();
  await follow.click();
  await expect(stopFollowing(page)).toBeVisible();
  await expect.poll(() => cameraDifference(page, leader)).toBeLessThan(0.01);

  await leader.mouse.move(500, 450);
  await leader.mouse.wheel(160, 220);
  await leader.getByRole("button", { name: "Приблизить", exact: true }).click();
  await expect.poll(async () => (await camera(leader)).scale).toBeGreaterThan(1.05);
  await expect.poll(() => cameraDifference(page, leader)).toBeLessThan(0.01);
  await expect(layers(page)).toHaveCount(0);
  await expect(page.getByRole("button", { name: /^Отменить/ })).toBeDisabled();

  await page.mouse.move(600, 600);
  await page.mouse.wheel(0, 120);
  await expect(stopFollowing(page)).toHaveCount(0);
  await expect(follow).toBeVisible();
  await expect.poll(() => cameraDifference(page, leader)).toBeGreaterThan(50);

  await follow.click();
  await expect.poll(() => cameraDifference(page, leader)).toBeLessThan(0.01);
  await page.getByRole("button", { name: "Не следовать за Ведущий v0.3", exact: true }).click();
  await expect(stopFollowing(page)).toHaveCount(0);

  await follow.click();
  await expect(stopFollowing(page)).toBeVisible();
  await page.getByRole("button", { name: "Приблизить", exact: true }).click();
  await expect(stopFollowing(page)).toHaveCount(0);

  await follow.click();
  await expect(stopFollowing(page)).toBeVisible();
  await leader.close();
  await expect(stopFollowing(page)).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Не следовать за Ведущий v0.3", exact: true })).toHaveCount(0);
  await expect(layers(page)).toHaveCount(0);
  await saved(page);
});

test("laser expires without pointerup, clears on tool change and lets a viewer point without editing", async ({ page, scenario }) => {
  await openBoard(page, await scenario.createBoard("E2E v0.3: лазер"));
  const viewer = await scenario.guest(await invitation(page, "viewer"), "Наблюдатель лазера");
  await expect(viewer.getByRole("button", { name: "Маркер", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /^Отменить/ })).toBeDisabled();
  await page.getByRole("button", { name: "Лазерная указка", exact: true }).click();
  await page.mouse.move(430, 380);
  await page.mouse.down();
  try {
    await page.mouse.move(650, 410, { steps: 10 });
    await expect(lasers(page)).toHaveCount(1);
    await expect(lasers(viewer)).toHaveCount(1);
    await expect(lasers(viewer).locator('[data-laser-trail="true"]')).toHaveAttribute("d", /^M.*L/);
    await expect(lasers(page)).toHaveCount(0, { timeout: 5_000 });
    await expect(lasers(viewer)).toHaveCount(0, { timeout: 5_000 });
    await page.mouse.move(700, 430, { steps: 4 });
    await expect(lasers(viewer)).toHaveCount(1);
    await page.keyboard.press("Escape");
    await expect(lasers(page)).toHaveCount(0);
    await expect(lasers(viewer)).toHaveCount(0);
  } finally { await page.mouse.up(); }

  await viewer.getByRole("button", { name: "Лазерная указка", exact: true }).click();
  await viewer.mouse.move(450, 480);
  await viewer.mouse.down();
  try {
    await viewer.mouse.move(640, 500, { steps: 8 });
    await expect(lasers(page)).toHaveCount(1);
    await expect(lasers(viewer)).toHaveCount(1);
  } finally { await viewer.mouse.up(); }
  await expect(lasers(page)).toHaveCount(0);
  await expect(lasers(viewer)).toHaveCount(0);
  await expect(layers(page)).toHaveCount(0);
  await expect(layers(viewer)).toHaveCount(0);
  await expect(page.getByRole("button", { name: /^Отменить/ })).toBeDisabled();
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(canvas(page)).toBeVisible();
  await expect(layers(page)).toHaveCount(0);
  await expect(lasers(page)).toHaveCount(0);
  await saved(page);
});

test("laser yields to a native pinch and suppresses the remaining touch", async ({ page, scenario, browserName }) => {
  test.skip(browserName !== "chromium", "Native multitouch is driven through Chromium CDP");
  await page.setViewportSize({ width: 1024, height: 768 });
  await openBoard(page, await scenario.createBoard("E2E v0.3: лазер и планшет"));
  const viewer = await scenario.guest(await invitation(page, "viewer"), "Лазер и жесты");
  await page.getByRole("button", { name: "Лазерная указка", exact: true }).click();
  const session = await page.context().newCDPSession(page);
  await session.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
  try {
    await touch(session, "touchStart", [{ id: 1, x: 400, y: 300 }]);
    await touch(session, "touchMove", [{ id: 1, x: 420, y: 300 }]);
    await expect(lasers(viewer)).toHaveCount(1);
    await touch(session, "touchStart", [{ id: 1, x: 420, y: 300 }, { id: 2, x: 600, y: 300 }]);
    await expect(lasers(viewer)).toHaveCount(0);
    await touch(session, "touchMove", [{ id: 1, x: 330, y: 280 }, { id: 2, x: 690, y: 280 }]);
    await expect.poll(async () => (await camera(page)).scale).toBeCloseTo(2);
    await touch(session, "touchEnd", [{ id: 2, x: 690, y: 280 }]);
    await touch(session, "touchMove", [{ id: 1, x: 550, y: 550 }]);
    await expect(lasers(page)).toHaveCount(0);
    await expect(lasers(viewer)).toHaveCount(0);
    await touch(session, "touchEnd", []);
    await expect(layers(page)).toHaveCount(0);
    await expect(page.getByRole("button", { name: /^Отменить/ })).toBeDisabled();
    await saved(page);
  } finally { await touch(session, "touchCancel", []).catch(() => {}); await session.detach(); }
});
