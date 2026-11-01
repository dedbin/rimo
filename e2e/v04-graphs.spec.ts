import { readFile } from "node:fs/promises";

import type { CDPSession, Locator, Page } from "@playwright/test";

import { LayerType } from "@/types/board-canvas";
import type { GraphLayer, GraphViewport, Layer } from "@/types/board-canvas";

import { canvas, copySelection, invitation, openBoard, pasteSelection, saved } from "./board-ui";
import { expect, test } from "./fixtures";

interface TouchPoint { id: number; x: number; y: number }
interface Camera { x: number; y: number; scale: number }

const graphs = (page: Page): Locator => canvas(page).locator('[data-graph-layer="true"]');
const editor = (page: Page): Locator => page.getByRole("complementary", { name: "Редактор графика", exact: true });
const formula = (page: Page, number: number): Locator => page.getByLabel(`Формула ${number}`, { exact: true });
const spanX = (viewport: GraphViewport): number => viewport.xMax - viewport.xMin;

async function insertGraph(page: Page): Promise<void> {
  await page.getByRole("button", { name: "График", exact: true }).click();
  await page.mouse.click(300, 220);
  await expect(graphs(page)).toHaveCount(1);
  await expect(editor(page)).toBeVisible();
  await expect(formula(page, 1)).toHaveValue("y = x^2");
  await expect(formula(page, 2)).toHaveValue("y = 2x + 1");
}

async function selectGraph(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Выделение", exact: true }).click();
  await graphs(page).click({ position: { x: 80, y: 50 } });
}

async function openEditor(page: Page): Promise<void> {
  await selectGraph(page);
  await page.getByRole("button", { name: "Редактировать график", exact: true }).click();
  await expect(editor(page)).toBeVisible();
}

async function copiedGraph(page: Page): Promise<GraphLayer> {
  const copied = await copySelection(page);
  expect(copied).not.toBe("");
  const payload = JSON.parse(copied) as { layers: Layer[] };
  expect(payload.layers).toHaveLength(1);
  expect(payload.layers[0].type).toBe(LayerType.Graph);
  return payload.layers[0] as GraphLayer;
}

async function resize(page: Page, handle: number, deltaX: number, deltaY: number): Promise<void> {
  const box = await canvas(page).locator(`rect[data-resize-handle="${handle}"]`).boundingBox();
  if (!box) throw new Error("Expected a graph resize handle");
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  try { await page.mouse.move(x + deltaX, y + deltaY, { steps: 10 }); }
  finally { await page.mouse.up(); }
}

async function camera(page: Page): Promise<Camera> {
  return canvas(page).locator('[data-board-layers="true"]').evaluate((element) => {
    const matrix = new DOMMatrixReadOnly(getComputedStyle(element).transform);
    return { x: matrix.e, y: matrix.f, scale: matrix.a };
  });
}

async function touch(session: CDPSession, type: "touchStart" | "touchMove" | "touchEnd" | "touchCancel", points: TouchPoint[]): Promise<void> {
  await session.send("Input.dispatchTouchEvent", { type,
    touchPoints: points.map((point) => ({ ...point, radiusX: 5, radiusY: 5, force: 0.5 })) });
}

test("graph formulas synchronize, isolate errors and survive proportional and side resizing, undo and reload", async ({ page, scenario }, info) => {
  test.setTimeout(120_000);
  const boardId = await scenario.createBoard("E2E v0.4: графики и совместное редактирование");
  await openBoard(page, boardId);
  const guest = await scenario.guest(await invitation(page, "editor"), "Ученик с графиками");
  const viewer = await scenario.guest(await invitation(page, "viewer"), "Просмотр графиков");
  await insertGraph(page);
  await expect(graphs(guest).locator("[data-graph-expression]")).toHaveCount(2);
  await expect(graphs(viewer)).toHaveCount(1);
  await expect(viewer.getByRole("button", { name: "График", exact: true })).toHaveCount(0);
  await graphs(viewer).dblclick({ position: { x: 80, y: 50 } });
  await expect(editor(viewer)).toHaveCount(0);
  await expect(viewer.getByRole("button", { name: "Редактировать график", exact: true })).toHaveCount(0);

  await page.getByRole("button", { name: "Добавить формулу", exact: true }).click();
  await formula(page, 3).fill("y <= 2x + 1");
  await expect(graphs(guest).locator("[data-graph-expression]")).toHaveCount(3);
  await expect(graphs(guest).locator('[data-graph-shading="true"]')).toHaveCount(1);
  await formula(page, 1).fill("y = sqrt(");
  await expect(formula(page, 1)).toHaveAttribute("aria-invalid", "true");
  await expect(graphs(guest).locator("[data-graph-expression]")).toHaveCount(2);
  await expect(graphs(guest).locator('[data-graph-shading="true"]')).toHaveCount(1);
  await formula(page, 1).fill("y = sin(x)");
  await expect(formula(page, 1)).toHaveAttribute("aria-invalid", "false");
  await expect(graphs(guest).locator("[data-graph-expression]")).toHaveCount(3);

  // The native color picker is OS UI. Exercise its ordinary input/change path,
  // without injecting board or Yjs state.
  await page.getByLabel("Цвет графика 1", { exact: true }).evaluate((element) => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(element, "#059669");
    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await expect(graphs(guest).locator('[data-graph-expression="parabola"] path').first()).toHaveCSS("stroke", "rgb(5, 150, 105)");
  await page.getByRole("button", { name: "Скрыть график 1", exact: true }).click();
  await expect(graphs(guest).locator('[data-graph-expression="parabola"]')).toHaveCount(0);
  await page.getByRole("button", { name: "Показать график 1", exact: true }).click();
  await expect(graphs(guest).locator('[data-graph-expression="parabola"]')).toHaveCount(1);

  await openEditor(guest);
  await formula(guest, 2).fill("y = 3x - 2");
  await expect(formula(page, 2)).toHaveValue("y = 3x - 2");
  await page.getByRole("button", { name: "Закрыть редактор графика", exact: true }).click();
  const initial = await copiedGraph(page);
  expect(initial).toMatchObject({ x: 300, y: 220, width: 640, height: 440 });
  await resize(page, 10, 128, 88);
  const corner = await copiedGraph(page);
  expect(corner.width / corner.height).toBeCloseTo(initial.width / initial.height, 5);
  expect(corner.width).toBeCloseTo(768, 1);
  expect(corner.height).toBeCloseTo(528, 1);
  expect(corner.x).toBe(initial.x);
  expect(corner.y).toBe(initial.y);
  expect(corner.graph.viewport).toEqual(initial.graph.viewport);

  await formula(guest, 2).fill("y = 4x - 3");
  await expect.poll(async () => (await copiedGraph(page)).graph.expressions.line.formula).toBe("y = 4x - 3");
  await resize(page, 8, 96, 0);
  const wide = await copiedGraph(page);
  expect(wide.width).toBeCloseTo(corner.width + 96, 1);
  expect(wide.height).toBe(corner.height);
  expect(wide.graph.viewport.xMin).toBe(corner.graph.viewport.xMin);
  expect(wide.graph.viewport.yMin).toBe(corner.graph.viewport.yMin);
  expect(wide.graph.viewport.yMax).toBe(corner.graph.viewport.yMax);
  expect(spanX(wide.graph.viewport)).toBeCloseTo(spanX(corner.graph.viewport) * wide.width / corner.width, 5);
  await page.getByRole("button", { name: /^Отменить/ }).click();
  await expect.poll(async () => (await copiedGraph(page)).width).toBeCloseTo(corner.width, 1);
  expect((await copiedGraph(page)).graph.expressions.line.formula).toBe("y = 4x - 3");
  await page.getByRole("button", { name: /^Повторить/ }).click();
  await expect.poll(async () => (await copiedGraph(page)).width).toBeCloseTo(wide.width, 1);
  await saved(page);
  await page.reload({ waitUntil: "domcontentloaded" });
  await saved(page);
  await expect(graphs(page)).toHaveCount(1);
  await selectGraph(page);
  const restored = await copiedGraph(page);
  expect(restored).toEqual(wide);
  await expect(graphs(viewer).locator('[data-graph-shading="true"]')).toHaveCount(1);
  await page.screenshot({ path: info.outputPath("v04-graph-editing.png") });
});

test("graph drag, wheel and native pinch change its axes while board navigation and Escape stay independent", async ({ page, scenario, browserName }) => {
  await openBoard(page, await scenario.createBoard("E2E v0.4: навигация графика и доски"));
  await insertGraph(page);
  const original = await copiedGraph(page);
  const boardCamera = await camera(page);
  await page.getByRole("button", { name: "Двигать оси", exact: true }).click();
  await expect(graphs(page).locator('[data-graph-interaction="true"]')).toHaveCount(1);
  await page.mouse.move(520, 410);
  await page.mouse.down();
  try { await page.mouse.move(600, 460, { steps: 10 }); }
  finally { await page.mouse.up(); }
  await expect.poll(async () => (await copiedGraph(page)).graph.viewport.xMin).not.toBe(original.graph.viewport.xMin);
  const panned = await copiedGraph(page);
  expect(spanX(panned.graph.viewport)).toBeCloseTo(spanX(original.graph.viewport), 5);
  expect(await camera(page)).toEqual(boardCamera);
  expect(panned).toMatchObject({ x: original.x, y: original.y, width: original.width, height: original.height });
  await page.mouse.move(550, 400);
  await page.mouse.wheel(0, -160);
  await expect.poll(async () => spanX((await copiedGraph(page)).graph.viewport)).toBeLessThan(spanX(panned.graph.viewport));
  const wheeled = await copiedGraph(page);
  expect(await camera(page)).toEqual(boardCamera);

  if (browserName === "chromium") {
    const session = await page.context().newCDPSession(page);
    await session.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
    try {
      await touch(session, "touchStart", [{ id: 1, x: 480, y: 440 }, { id: 2, x: 680, y: 440 }]);
      await touch(session, "touchMove", [{ id: 1, x: 430, y: 440 }, { id: 2, x: 730, y: 440 }]);
      await touch(session, "touchEnd", []);
      await expect.poll(async () => spanX((await copiedGraph(page)).graph.viewport)).toBeLessThan(spanX(wheeled.graph.viewport) * 0.9);
      expect(await camera(page)).toEqual(boardCamera);
    } finally { await touch(session, "touchCancel", []).catch(() => {}); await session.detach(); }
  }
  const navigated = await copiedGraph(page);
  // Focus a toolbar button outside the panel: Escape must leave the selection.
  await page.getByRole("button", { name: "Редактировать график", exact: true }).focus();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("button", { name: "Двигать оси", exact: true })).toHaveAttribute("aria-pressed", "false");
  await expect(editor(page)).toBeVisible();
  await expect(canvas(page).locator("[data-resize-handle]")).toHaveCount(8);
  expect((await copiedGraph(page)).graph.viewport).toEqual(navigated.graph.viewport);
  await page.mouse.move(550, 400);
  await page.mouse.wheel(40, 80);
  await expect.poll(async () => (await camera(page)).y).toBeLessThan(boardCamera.y - 40);
  expect((await copiedGraph(page)).graph.viewport).toEqual(navigated.graph.viewport);
  await saved(page);
});

test("graphs, inequalities and separate discontinuous branches survive clipboard, real PDF and portable archive", async ({ page, scenario }, info) => {
  test.setTimeout(120_000);
  await openBoard(page, await scenario.createBoard("E2E v0.4: исходный график"));
  await insertGraph(page);
  await formula(page, 1).fill("y = 1/x");
  await formula(page, 2).fill("y >= x^2 - 1");
  await page.getByRole("button", { name: "Добавить формулу", exact: true }).click();
  await formula(page, 3).fill("x < 2");
  await expect(graphs(page).locator('[data-graph-expression="parabola"] > path')).toHaveCount(2);
  await expect(graphs(page).locator('[data-graph-shading="true"]')).toHaveCount(2);
  await saved(page);
  await page.getByRole("button", { name: "Закрыть редактор графика", exact: true }).click();
  const original = await copiedGraph(page);
  const clipboard = await copySelection(page);
  const boardId = await scenario.createBoard("E2E v0.4: копия, PDF и архив");
  await openBoard(page, boardId);
  await page.mouse.move(400, 260);
  await pasteSelection(page, clipboard);
  await expect(graphs(page)).toHaveCount(1);
  const pasted = await copiedGraph(page);
  expect(pasted.graph).toEqual(original.graph);
  expect(pasted.width).toBe(original.width);
  expect(pasted.height).toBe(original.height);
  await saved(page);
  if (await editor(page).isVisible()) await page.getByRole("button", { name: "Закрыть редактор графика", exact: true }).click();
  await page.getByRole("button", { name: "PDF", exact: true }).click();
  const prepared = page.waitForResponse((response) => new URL(response.url()).pathname.endsWith("/pdf/preview") && response.request().method() === "POST");
  await page.getByRole("button", { name: "Создать предпросмотр", exact: true }).click();
  expect((await prepared).status()).toBe(201);
  const preview = page.frameLocator('iframe[title^="Предпросмотр:"]');
  await expect(preview.locator('[data-graph-plot="true"]')).toHaveCount(1);
  await expect(preview.locator('[data-graph-expression="parabola"] > path')).toHaveCount(2);
  await expect(preview.locator('[data-graph-shading="true"]')).toHaveCount(2);
  const acceptance = page.getByLabel("Я проверил масштаб и границы всех страниц", { exact: true });
  if (await acceptance.count()) await acceptance.check();
  const pdfEvent = page.waitForEvent("download");
  await page.getByRole("button", { name: "Скачать PDF", exact: true }).click();
  const pdfPath = info.outputPath("v04-graphs.pdf");
  await (await pdfEvent).saveAs(pdfPath);
  expect((await readFile(pdfPath)).subarray(0, 5).toString()).toBe("%PDF-");
  await page.keyboard.press("Escape");

  const archiveEvent = page.waitForEvent("download");
  await page.getByRole("button", { name: "Действия с доской", exact: true }).click();
  await page.getByRole("button", { name: "Архив", exact: true }).click();
  const archivePath = info.outputPath("v04-graphs.rimo");
  await (await archiveEvent).saveAs(archivePath);
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Действия с доской", exact: true }).click();
  const imported = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/boards/import" && response.request().method() === "POST");
  await page.getByLabel("Архив Rimo", { exact: true }).setInputFiles(archivePath);
  expect((await imported).status()).toBe(201);
  await page.waitForURL((url) => /^\/board\/[a-f0-9-]{36}$/.test(url.pathname) && url.pathname !== `/board/${boardId}`);
  scenario.createdBoards.add(new URL(page.url()).pathname.split("/").at(-1)!);
  await saved(page);
  await selectGraph(page);
  expect(await copiedGraph(page)).toEqual(pasted);
  await expect(graphs(page).locator('[data-graph-expression="parabola"] > path')).toHaveCount(2);
  await expect(graphs(page).locator('[data-graph-shading="true"]')).toHaveCount(2);
});

test("phone and tablet keep long-title actions and the whole graph visible while its editor stays usable", async ({ page, scenario }, info) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const boardId = await scenario.createBoard("E2E v0.4: длинное название урока о функциях, неравенствах и декартовой системе координат");
  await openBoard(page, boardId);
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  for (const name of ["Поделиться", "PDF"]) {
    const action = page.getByRole("button", { name, exact: true });
    await expect(action).toBeInViewport({ ratio: 1 });
    const box = await action.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(390);
  }
  await insertGraph(page);
  await expect.poll(async () => {
    const [plot, panel] = await Promise.all([graphs(page).boundingBox(), editor(page).boundingBox()]);
    return !!plot && !!panel && plot.x >= 64 && plot.y >= 100 &&
      plot.x + plot.width <= 390 && plot.y + plot.height <= panel.y - 8;
  }).toBe(true);
  const original = await copiedGraph(page);
  await expect.poll(async () => {
    const [tools, presence] = await Promise.all([page.getByRole("toolbar").boundingBox(), page.locator('[data-board-presence="true"]').boundingBox()]);
    return !!tools && !!presence && tools.y >= presence.y + presence.height + 2;
  }).toBe(true);
  expect(original).toMatchObject({ x: 300, y: 220, width: 640, height: 440 });
  const panelBox = await editor(page).boundingBox();
  expect(panelBox!.height).toBeLessThanOrEqual(844 * 0.45 + 1);
  await page.mouse.move(panelBox!.x + panelBox!.width / 2, panelBox!.y + panelBox!.height - 35);
  await page.mouse.wheel(0, 420);
  const navigate = page.getByRole("button", { name: "Двигать оси", exact: true });
  await navigate.scrollIntoViewIfNeeded();
  // Fractional bottom-sheet heights may clip half a CSS pixel after scrolling.
  await expect(navigate).toBeInViewport({ ratio: 0.95 });
  await navigate.click();
  await expect(navigate).toHaveAttribute("aria-pressed", "true");
  await navigate.click();
  await expect(navigate).toHaveAttribute("aria-pressed", "false");
  await page.getByLabel("Показывать сетку", { exact: true }).scrollIntoViewIfNeeded();
  await expect(page.getByLabel("Показывать сетку", { exact: true })).toBeInViewport({ ratio: 0.95 });
  await page.screenshot({ path: info.outputPath("v04-phone-editor.png") });
  await page.getByRole("button", { name: "Закрыть редактор графика", exact: true }).click();
  await expect(editor(page)).toHaveCount(0);
  expect(await copiedGraph(page)).toEqual(original);
  await expect(page.getByRole("button", { name: "График", exact: true })).toBeInViewport({ ratio: 1 });

  await page.setViewportSize({ width: 1024, height: 768 });
  await page.locator("button:has(svg.lucide-maximize)").click();
  await expect.poll(async () => (await graphs(page).boundingBox())?.width ?? 0).toBeGreaterThan(800);
  await openEditor(page);
  await expect.poll(async () => {
    const [plot, panel] = await Promise.all([graphs(page).boundingBox(), editor(page).boundingBox()]);
    return !!plot && !!panel && plot.x >= 64 && plot.y >= 70 &&
      plot.x + plot.width <= panel.x - 12 && plot.y + plot.height <= 728;
  }).toBe(true);
  expect(await copiedGraph(page)).toEqual(original);
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(1024);
  await page.screenshot({ path: info.outputPath("v04-tablet-editor.png") });
  await saved(page);
});
