import { LayerType } from "../types/board-canvas";
import type { LineLayer, PathLayer, Point } from "../types/board-canvas";

import { canvas, insertText, invitation, openBoard, saved, texts } from "./board-ui";
import { autoPan, camera, centerMouse, edgePoint, expectIdle, expectMotion, layers, observeCamera,
  screenCenter, selectedLayers } from "./cursor-edge-pan-ui";
import type { Edge } from "./cursor-edge-pan-ui";
import { expect, test } from "./fixtures";

test("stationary hover scrolls every edge, survives pointerup and stops in the center", async ({ page, scenario }) => {
  await openBoard(page, await scenario.createBoard("E2E автопрокрутка: четыре края"));
  await expect(autoPan(page)).toHaveAttribute("aria-pressed", "true");
  const edges: { edge: Edge; direction: Point }[] = [
    { edge: "right", direction: { x: -1, y: 0 } }, { edge: "bottom", direction: { x: 0, y: -1 } },
    { edge: "left", direction: { x: 1, y: 0 } }, { edge: "top", direction: { x: 0, y: 1 } },
  ];
  for (const { edge, direction } of edges) await test.step(edge, async () => {
    const initial = await camera(page);
    const point = await edgePoint(page, edge);
    await page.mouse.move(point.x, point.y);
    await expectMotion(page, initial, direction);
    const scrolling = await observeCamera(page);
    expect(scrolling.distance).toBeGreaterThan(15);
    expect(Math.hypot(scrolling.last.x - scrolling.first.x, scrolling.last.y - scrolling.first.y))
      .toBeLessThanOrEqual(480 * scrolling.elapsed / 1000 + 5);
    expect(scrolling.last.scale).toBe(initial.scale);
    await page.mouse.down();
    await page.mouse.up();
    await expectMotion(page, await camera(page), direction, 25);
    await centerMouse(page);
    await expectIdle(page);
  });
  await expect(layers(page)).toHaveCount(0);
  await expect(page.getByRole("button", { name: /^Отменить/ })).toBeDisabled();
});

test("the local switch persists after reload and across boards", async ({ page, scenario }) => {
  const first = await scenario.createBoard("E2E автопрокрутка: настройка");
  await openBoard(page, first);
  await autoPan(page).click();
  await expect(autoPan(page)).toHaveAttribute("aria-pressed", "false");
  let point = await edgePoint(page, "right");
  await page.mouse.move(point.x, point.y);
  await expectIdle(page);
  await page.reload({ waitUntil: "domcontentloaded" });
  await saved(page);
  await expect(autoPan(page)).toHaveAttribute("aria-pressed", "false");
  point = await edgePoint(page, "right");
  await page.mouse.move(point.x, point.y);
  await expectIdle(page);
  await openBoard(page, await scenario.createBoard("E2E автопрокрутка: другая доска"));
  await expect(autoPan(page)).toHaveAttribute("aria-pressed", "false");
  await autoPan(page).click();
  await expect(autoPan(page)).toHaveAttribute("aria-pressed", "true");
  const initial = await camera(page);
  point = await edgePoint(page, "right");
  await page.mouse.move(point.x, point.y);
  await expectMotion(page, initial, { x: -1, y: 0 });
  await centerMouse(page);
});

test("wheel, Escape and native pen or touch input discard a parked mouse", async ({ page, scenario, browserName }) => {
  await openBoard(page, await scenario.createBoard("E2E автопрокрутка: сброс"));
  const point = await edgePoint(page, "right");
  await page.mouse.move(point.x, point.y);
  await expectMotion(page, await camera(page), { x: -1, y: 0 });
  const beforeWheel = await camera(page);
  await page.mouse.wheel(0, 120);
  await expect.poll(async () => (await camera(page)).y).toBe(beforeWheel.y - 120);
  await expectIdle(page);
  await centerMouse(page);
  await page.mouse.move(point.x, point.y);
  await expectMotion(page, await camera(page), { x: -1, y: 0 });
  await page.keyboard.press("Escape");
  await expectIdle(page);
  if (browserName === "chromium") {
    const session = await page.context().newCDPSession(page);
    try {
      await centerMouse(page);
      await page.mouse.move(point.x, point.y);
      await expectMotion(page, await camera(page), { x: -1, y: 0 });
      await session.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: point.x, y: point.y, pointerType: "pen" });
      await expectIdle(page);
      await centerMouse(page);
      await page.mouse.move(point.x, point.y);
      await expectMotion(page, await camera(page), { x: -1, y: 0 });
      await session.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
      await session.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: 700, y: 400, id: 1 }] });
      await session.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
      await expectIdle(page);
    } finally {
      await session.send("Emulation.setTouchEmulationEnabled", { enabled: false });
      await session.detach();
    }
  }
  await centerMouse(page);
  await expect(layers(page)).toHaveCount(0);
});

test("a stationary edge keeps extending a marker stroke and its undo stays atomic", async ({ page, scenario }) => {
  await openBoard(page, await scenario.createBoard("E2E автопрокрутка: маркер"));
  await page.getByRole("button", { name: "Маркер", exact: true }).click();
  const point = await edgePoint(page, "right");
  const initial = await camera(page);
  await page.mouse.move(point.x - 220, point.y);
  await page.mouse.down();
  try {
    await page.mouse.move(point.x, point.y, { steps: 6 });
    await expectMotion(page, initial, { x: -1, y: 0 }, 100);
    await expect(layers(page)).toHaveCount(0);
  } finally { await page.mouse.up(); }
  await centerMouse(page);
  await expect(layers(page)).toHaveCount(1);
  await page.keyboard.press("Escape");
  await canvas(page).locator("[data-layer-id] path").click();
  const [stroke] = await selectedLayers(page) as PathLayer[];
  expect(stroke.type).toBe(LayerType.Path);
  const end = stroke.points.at(-1)!;
  expect(stroke.x + end[0]).toBeGreaterThan((point.x - initial.x) / initial.scale + 60);
  expect(stroke.y + end[1]).toBeCloseTo((point.y - initial.y) / initial.scale, 1);
  await page.getByRole("button", { name: /^Отменить/ }).click();
  await expect(layers(page)).toHaveCount(0);
  await expect(page.getByRole("button", { name: /^Отменить/ })).toBeDisabled();
  await page.getByRole("button", { name: /^Повторить/ }).click();
  await expect(layers(page)).toHaveCount(1);
  await saved(page);
});

test("moving and resizing retain the cursor anchor with one undo per action", async ({ page, scenario }) => {
  await openBoard(page, await scenario.createBoard("E2E автопрокрутка: перенос и размер"));
  const point = await edgePoint(page, "right");
  await page.getByRole("button", { name: /^Прямоугольник/ }).click();
  await page.mouse.click(point.x - 300, point.y - 50);
  await page.keyboard.press("Escape");
  const shape = canvas(page).locator("[data-layer-id] > rect");
  await shape.click();
  const [original] = await selectedLayers(page);
  const origin = await screenCenter(shape);
  const initial = await camera(page);
  await page.mouse.move(origin.x, origin.y);
  await page.mouse.down();
  try {
    await page.mouse.move(point.x, point.y, { steps: 6 });
    await expectMotion(page, initial, { x: -1, y: 0 }, 80);
    await expect.poll(async () => {
      const center = await screenCenter(shape);
      return Math.hypot(center.x - point.x, center.y - point.y);
    }).toBeLessThan(3);
  } finally { await page.mouse.up(); }
  await centerMouse(page);
  const [moved] = await selectedLayers(page);
  expect(moved.x).toBeGreaterThan(original.x + 250);
  await page.getByRole("button", { name: /^Отменить/ }).click();
  expect(await selectedLayers(page)).toEqual([original]);
  await page.getByRole("button", { name: "Уместить все", exact: true }).click();
  await expect.poll(async () => (await camera(page)).scale).toBe(4);
  const handle = canvas(page).locator('[data-resize-handle="8"]');
  const start = await screenCenter(handle);
  const fitted = await camera(page);
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  try {
    await page.mouse.move(point.x, start.y, { steps: 6 });
    await expectMotion(page, fitted, { x: -1, y: 0 }, 80);
    await expect.poll(async () => Math.abs((await screenCenter(handle)).x - point.x)).toBeLessThan(3);
  } finally { await page.mouse.up(); }
  await centerMouse(page);
  expect((await selectedLayers(page))[0].width).toBeGreaterThan(original.width + 100);
  await page.getByRole("button", { name: /^Отменить/ }).click();
  expect(await selectedLayers(page)).toEqual([original]);
  await saved(page);
});

test("a selection net reaches offscreen objects and a line extends under a parked cursor", async ({ page, scenario }) => {
  await openBoard(page, await scenario.createBoard("E2E автопрокрутка: выделение и линия"));
  const point = await edgePoint(page, "right");
  await centerMouse(page);
  await page.mouse.wheel(450, 0);
  await expect.poll(async () => (await camera(page)).x).toBe(-450);
  await page.getByRole("button", { name: /^Прямоугольник/ }).click();
  await page.mouse.click(point.x - 180, 500);
  await page.keyboard.press("Escape");
  await centerMouse(page);
  await page.mouse.wheel(-450, 0);
  await expect.poll(async () => (await camera(page)).x).toBe(0);
  await page.mouse.move(point.x - 250, 350);
  await page.mouse.down();
  try {
    await page.mouse.move(point.x, 700, { steps: 6 });
    await expectMotion(page, { x: 0, y: 0, scale: 1 }, { x: -1, y: 0 }, 430);
  } finally { await page.mouse.up(); }
  await centerMouse(page);
  const selected = await selectedLayers(page);
  expect(selected).toHaveLength(1);
  expect(selected[0]).toMatchObject({ type: LayerType.Rectangle, x: point.x - 180 + 450 });
  await page.getByRole("button", { name: "Линии", exact: true }).click();
  await page.getByRole("menuitemradio", { name: "Отрезок", exact: true }).click();
  const initial = await camera(page);
  await page.mouse.move(point.x - 220, 260);
  await page.mouse.down();
  try {
    await page.mouse.move(point.x, 260, { steps: 6 });
    await expectMotion(page, initial, { x: -1, y: 0 }, 100);
  } finally { await page.mouse.up(); }
  await centerMouse(page);
  const [line] = await selectedLayers(page) as LineLayer[];
  expect(line.type).toBe(LayerType.Line);
  expect(line.x + line.end.x * line.width).toBeGreaterThan((point.x - initial.x) / initial.scale + 60);
  await page.getByRole("button", { name: /^Отменить/ }).click();
  await expect(canvas(page).locator('[data-line-body="true"]')).toHaveCount(0);
  await saved(page);
});

test("clicks, active text, modal UI and graph navigation keep a parked mouse from moving the board", async ({ page, scenario }) => {
  await openBoard(page, await scenario.createBoard("E2E автопрокрутка: текст и панели"));
  const block = await insertText(page, "Текст у края");
  const point = await edgePoint(page, "right");
  await page.mouse.move(point.x, point.y);
  await page.keyboard.type(" и продолжение");
  await expect(page.getByRole("textbox", { name: "Текст на доске", exact: true })).toContainText("и продолжение");
  await expectIdle(page);
  await page.mouse.click(900, 750);
  const original = await screenCenter(block);
  await block.click();
  expect(await screenCenter(block)).toEqual(original);
  await block.dblclick();
  await expect(page.getByRole("textbox", { name: "Текст на доске", exact: true })).toBeVisible();
  await expect(texts(page)).toHaveCount(1);
  await page.mouse.click(900, 750);
  await page.getByRole("button", { name: "Поделиться", exact: true }).click();
  await page.mouse.move(point.x, point.y);
  await expectIdle(page);
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "График", exact: true }).click();
  await page.mouse.click(300, 220);
  await expect(page.getByRole("complementary", { name: "Редактор графика", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Двигать оси", exact: true }).click();
  await page.mouse.move(point.x, point.y);
  // Opening the plot editor may finish its existing fit animation first.
  await observeCamera(page, 300);
  await expectIdle(page);
  await page.getByRole("button", { name: "Закрыть редактор графика", exact: true }).click();
  await saved(page);
});

test("a delayed double click edits a narrow text block at the edge without moving it", async ({ page, scenario }) => {
  await openBoard(page, await scenario.createBoard("E2E автопрокрутка: двойной клик у края"));
  await autoPan(page).click();
  await expect(autoPan(page)).toHaveAttribute("aria-pressed", "false");
  const edge = await edgePoint(page, "right");
  await page.getByRole("button", { name: /^Текст \(/ }).click();
  await page.mouse.click(edge.x - 96, edge.y - 50);
  const block = texts(page).first();
  await expect(block).toBeVisible();
  await block.dblclick();
  const editor = page.getByRole("textbox", { name: "Текст на доске", exact: true });
  await expect(editor).toBeVisible();
  await editor.fill("Я");
  await page.mouse.click(900, 750);
  await block.click();
  const handle = canvas(page).locator('[data-resize-handle="4"]');
  const start = await screenCenter(handle);
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(start.x + 60, start.y, { steps: 4 });
  await page.mouse.up();
  await expect(canvas(page).locator("[data-layer-id] > foreignObject")).toHaveAttribute("width", "40");
  await saved(page);
  await autoPan(page).click();
  await expect(autoPan(page)).toHaveAttribute("aria-pressed", "true");
  const target = await screenCenter(block);
  expect(target.x).toBeGreaterThan(edge.x - 44);
  await page.mouse.move(target.x, target.y);
  await page.mouse.down({ clickCount: 1 });
  await page.mouse.up({ clickCount: 1 });
  const betweenClicks = await observeCamera(page, 180);
  // Keep the physical mouse still: a fresh mousemove would mask this regression.
  await page.mouse.down({ clickCount: 2 });
  await page.mouse.up({ clickCount: 2 });
  await expect(editor).toBeVisible();
  await expect(editor).toContainText("Я");
  expect(betweenClicks.distance, "The text stays under the mouse between the two clicks").toBeLessThan(1);
  await saved(page);
});

test("a viewer pans locally and an edge mouse does not interrupt following", async ({ page, scenario }) => {
  await openBoard(page, await scenario.createBoard("E2E автопрокрутка: зритель и следование"));
  const viewer = await scenario.guest(await invitation(page, "viewer"), "Наблюдатель прокрутки");
  const ownerCamera = await camera(page);
  const point = await edgePoint(viewer, "right");
  await viewer.mouse.move(point.x, point.y);
  await expectMotion(viewer, await camera(viewer), { x: -1, y: 0 });
  await centerMouse(viewer);
  expect(await camera(page)).toEqual(ownerCamera);
  await expect(layers(viewer)).toHaveCount(0);
  await page.getByRole("button", { name: "Следовать за Наблюдатель прокрутки", exact: true }).click();
  const stop = page.getByRole("button", { name: "Прекратить следование", exact: true });
  await expect(stop).toBeVisible();
  await expect.poll(() => camera(page)).toEqual(await camera(viewer));
  await page.mouse.move(point.x, point.y);
  await expectIdle(page);
  await expect(stop).toBeVisible();
  const before = await camera(viewer);
  await viewer.mouse.move(point.x, point.y);
  await expectMotion(viewer, before, { x: -1, y: 0 }, 80);
  await centerMouse(viewer);
  await expect.poll(() => camera(page)).toEqual(await camera(viewer));
  await expect(stop).toBeVisible();
  await expect(layers(page)).toHaveCount(0);
  await expect(page.getByRole("button", { name: /^Отменить/ })).toBeDisabled();
});

test("the laser stays under a stationary edge cursor without creating document edits", async ({ page, scenario }) => {
  await openBoard(page, await scenario.createBoard("E2E автопрокрутка: указка"));
  const viewer = await scenario.guest(await invitation(page, "viewer"), "Наблюдатель указки");
  const dots = canvas(page).locator('[data-laser-dot="true"]');
  await page.getByRole("button", { name: "Лазерная указка", exact: true }).click();
  const point = await edgePoint(page, "right");
  await page.mouse.move(point.x, point.y);
  await expectMotion(page, await camera(page), { x: -1, y: 0 });
  await expect(dots).toHaveCount(0);
  await centerMouse(page);
  const initial = await camera(page);
  await page.mouse.down();
  try {
    await page.mouse.move(point.x, point.y, { steps: 6 });
    await expectMotion(page, initial, { x: -1, y: 0 }, 100);
    await expect.poll(async () => {
      const dot = await screenCenter(dots);
      return Math.hypot(dot.x - point.x, dot.y - point.y);
    }).toBeLessThan(25);
    await expect(canvas(viewer).locator('[data-laser-dot="true"]')).toHaveCount(1);
  } finally { await page.mouse.up(); }
  await centerMouse(page);
  await expect(dots).toHaveCount(0);
  await expect(canvas(viewer).locator('[data-laser-dot="true"]')).toHaveCount(0);
  await expect(layers(page)).toHaveCount(0);
  await expect(layers(viewer)).toHaveCount(0);
  await expect(page.getByRole("button", { name: /^Отменить/ })).toBeDisabled();
});
