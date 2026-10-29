import type { Locator, Page } from "@playwright/test";

import { LayerType } from "../types/board-canvas";
import { canvas, copySelection, invitation, openBoard, saved } from "./board-ui";
import { expect, test } from "./fixtures";

interface Coordinates { x1: number; y1: number; x2: number; y2: number }

const bodies = (page: Page): Locator => canvas(page).locator('[data-line-body="true"]');
const arrows = (page: Page): Locator => canvas(page).locator("[data-line-arrow]");

async function coordinates(line: Locator): Promise<Coordinates> {
  return line.evaluate((element) => {
    const graphic = element as SVGLineElement;
    return { x1: graphic.x1.baseVal.value, y1: graphic.y1.baseVal.value,
      x2: graphic.x2.baseVal.value, y2: graphic.y2.baseVal.value };
  });
}

async function draw(page: Page, from: { x: number; y: number }, to: { x: number; y: number }, shift = false): Promise<void> {
  await page.mouse.move(from.x, from.y);
  if (shift) await page.keyboard.down("Shift");
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 8 });
  await page.mouse.up();
  if (shift) await page.keyboard.up("Shift");
}

async function selectedLine(page: Page): Promise<{ type: LayerType; lineKind: string } | null> {
  const copied = await copySelection(page);
  if (!copied) return null;
  const payload = JSON.parse(copied) as { layers: { type: LayerType; lineKind: string }[] };
  return payload.layers.length === 1 ? payload.layers[0] : null;
}

test("segments keep Shift alignment and endpoint arrows across collaboration, undo and reload", async ({ page, scenario }) => {
  const boardId = await scenario.createBoard("E2E отрезки и стрелки");
  await openBoard(page, boardId);
  const guest = await scenario.guest(await invitation(page, "editor"), "Геометрия");
  await page.getByRole("button", { name: "Линии", exact: true }).click();
  await page.getByRole("menuitemradio", { name: "Отрезок", exact: true }).click();
  await draw(page, { x: 420, y: 330 }, { x: 720, y: 338 }, true);
  await expect(bodies(page)).toHaveCount(1);
  await expect(bodies(guest)).toHaveCount(1);
  const first = bodies(page).first();
  const initial = await coordinates(first);
  expect(initial.y1).toBe(initial.y2);
  expect(initial.x2).toBeGreaterThan(720);

  // Each new polygon side starts exactly at the previous endpoint. Selection
  // handles must not turn that next drawing gesture into editing the old side.
  await draw(page, { x: initial.x2, y: initial.y2 }, { x: 700, y: 520 });
  await expect(bodies(page)).toHaveCount(2);
  await expect.poll(() => coordinates(first)).toEqual(initial);
  await draw(page, { x: 700, y: 520 }, { x: initial.x1, y: initial.y1 });
  await expect(bodies(page)).toHaveCount(3);
  await expect(bodies(guest)).toHaveCount(3);
  await expect.poll(() => coordinates(first)).toEqual(initial);
  await page.getByRole("button", { name: "Выделение", exact: true }).click();
  await page.mouse.click(500, 330);
  await page.getByRole("button", { name: "Стрелка в начале", exact: true }).click();
  await page.getByRole("button", { name: "Стрелка в конце", exact: true }).click();
  await expect(arrows(page)).toHaveCount(2);
  await page.getByRole("button", { name: /^Цвет линии:/ }).click();
  await page.getByRole("menuitemradio", { name: "Цвет линии: Синий", exact: true }).click();
  await page.getByRole("button", { name: /^Толщина:/ }).click();
  await page.getByRole("menuitemradio", { name: "6 пкс", exact: true }).click();
  await expect(first).toHaveAttribute("stroke", "#3b82f6");
  await expect(first).toHaveAttribute("stroke-width", "6");
  await expect(arrows(guest)).toHaveCount(2);
  await expect(bodies(guest).first()).toHaveAttribute("stroke", "#3b82f6");

  // Crossing the other endpoint preserves which logical end carries each arrow.
  const startHandle = canvas(page).locator('[data-line-handle="start"]');
  const handle = await startHandle.boundingBox();
  if (!handle) throw new Error("Expected a segment start handle");
  await draw(page, { x: handle.x + handle.width / 2, y: handle.y + handle.height / 2 }, { x: 800, y: 410 });
  const moved = { x1: 800, y1: 410, x2: initial.x2, y2: initial.y2 };
  await expect.poll(() => coordinates(first)).toEqual(moved);
  await expect.poll(() => coordinates(bodies(guest).first())).toEqual(moved);
  const startTip = () => canvas(page).locator('[data-line-arrow="start"]').getAttribute("points");
  await expect.poll(async () => (await startTip())?.split(" ")[0]).toBe("800,410");
  await page.getByRole("button", { name: /^Отменить/ }).click();
  await expect.poll(() => coordinates(first)).toEqual(initial);
  await expect(arrows(page)).toHaveCount(2);
  await expect(first).toHaveAttribute("stroke-width", "6");
  await page.getByRole("button", { name: /^Повторить/ }).click();
  await expect.poll(() => coordinates(first)).toEqual(moved);

  await page.getByRole("button", { name: /^Тип линии:/ }).click();
  await page.getByRole("menuitemradio", { name: "Прямая", exact: true }).click();
  await expect(first).toHaveAttribute("data-line-kind", "line");
  await expect(arrows(page)).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Стрелка в конце", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: /^Тип линии:/ }).click();
  await page.getByRole("menuitemradio", { name: "Отрезок", exact: true }).click();
  await expect(arrows(page)).toHaveCount(2);
  await saved(page);
  await saved(guest);
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(bodies(page)).toHaveCount(3);
  await expect.poll(() => coordinates(bodies(page).first())).toEqual(moved);
  await expect(bodies(page).first()).toHaveAttribute("stroke-width", "6");
  await expect(bodies(page).first()).toHaveAttribute("stroke", "#3b82f6");
  await expect(arrows(page)).toHaveCount(2);
  await saved(page);
});

test("straight lines remain visible and selectable beyond their anchors after panning", async ({ page, scenario }) => {
  const boardId = await scenario.createBoard("E2E бесконечная прямая");
  await openBoard(page, boardId);
  await page.getByRole("button", { name: "Линии", exact: true }).click();
  await page.getByRole("menuitemradio", { name: "Прямая", exact: true }).click();
  await draw(page, { x: 360, y: 420 }, { x: 560, y: 420 });
  await expect(bodies(page)).toHaveCount(1);
  await expect(bodies(page).first()).toHaveAttribute("data-line-kind", "line");
  const original = await coordinates(bodies(page).first());
  expect(original.x1).toBeLessThan(360);
  expect(original.x2).toBeGreaterThan(560);

  // Deselect before pan so viewport culling cannot rely on the selected-ID bypass.
  await page.keyboard.press("Escape");
  await expect(canvas(page)).toHaveCSS("cursor", "default");
  await page.mouse.move(1000, 700);
  await page.mouse.wheel(4000, 0);
  await expect.poll(async () => (await coordinates(bodies(page).first())).x1).toBeGreaterThan(2000);
  await draw(page, { x: 1100, y: 390 }, { x: 1200, y: 450 });
  await expect.poll(() => selectedLine(page)).toMatchObject({ type: LayerType.Line, lineKind: "line" });
  await expect(page.getByRole("button", { name: "Стрелка в начале", exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Стрелка в конце", exact: true })).toBeDisabled();
  await saved(page);
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(bodies(page)).toHaveCount(1);
  await expect(bodies(page).first()).toHaveAttribute("data-line-kind", "line");
  await expect.poll(() => coordinates(bodies(page).first())).toEqual(original);
  await saved(page);
});

test("Escape exits the sticky line tool and a zoomed thick stroke is selectable at its visible edge", async ({ page, scenario }) => {
  const boardId = await scenario.createBoard("E2E попадание по толстой линии");
  await openBoard(page, boardId);
  const tool = page.getByRole("button", { name: "Линии", exact: true });
  await tool.click();
  await page.getByRole("menuitemradio", { name: "Отрезок", exact: true }).click();
  await expect(canvas(page)).toHaveCSS("cursor", "crosshair");
  // Escape also works while Radix has returned focus to its trigger button.
  await page.keyboard.press("Escape");
  await expect(canvas(page)).toHaveCSS("cursor", "default");
  await page.mouse.click(720, 500);
  await expect(bodies(page)).toHaveCount(0);

  await tool.click();
  await page.getByRole("menuitemradio", { name: "Отрезок", exact: true }).click();
  await draw(page, { x: 600, y: 500 }, { x: 840, y: 500 });
  await expect(bodies(page)).toHaveCount(1);
  await page.getByRole("button", { name: /^Толщина:/ }).click();
  await page.getByRole("menuitemradio", { name: "8 пкс", exact: true }).click();
  await expect(bodies(page).first()).toHaveAttribute("stroke-width", "8");
  await page.keyboard.press("Escape");
  await expect(canvas(page)).toHaveCSS("cursor", "default");
  await expect.poll(() => selectedLine(page)).toBeNull();
  await page.mouse.move(720, 500);
  await page.keyboard.down("Control");
  await page.mouse.wheel(0, -600);
  await page.keyboard.up("Control");
  await expect(page.getByText("400%", { exact: true })).toBeVisible();
  // The painted stroke is 32 screen pixels wide; this point is outside the
  // fixed 16-pixel transparent hit area but still visibly inside the stroke.
  await page.mouse.click(720, 512);
  await expect.poll(() => selectedLine(page)).toMatchObject({ type: LayerType.Line, lineKind: "segment", strokeWidth: 8 });
  await saved(page);
});
