import type { Locator, Page } from "@playwright/test";

import { LayerType } from "../types/board-canvas";
import type { Point } from "../types/board-canvas";
import { canvas, copySelection, openBoard, saved } from "./board-ui";
import { expect, test } from "./fixtures";

async function selectedTypes(page: Page): Promise<LayerType[]> {
  const copied = await copySelection(page);
  if (!copied) return [];
  const payload = JSON.parse(copied) as { layers: { type: LayerType }[] };
  return payload.layers.map((layer) => layer.type);
}

async function hitbox(shape: Locator): Promise<{ x: number; y: number; width: number; height: number }> {
  return shape.evaluate((element) => {
    const graphic = element as SVGGraphicsElement;
    const bounds = graphic.getBBox();
    const matrix = graphic.getScreenCTM();
    if (!matrix) throw new Error("Expected a rendered SVG shape");
    const from = new DOMPoint(bounds.x, bounds.y).matrixTransform(matrix);
    const to = new DOMPoint(bounds.x + bounds.width, bounds.y + bounds.height).matrixTransform(matrix);
    return { x: from.x, y: from.y, width: to.x - from.x, height: to.y - from.y };
  });
}

async function selectBox(page: Page, from: Point, to: Point): Promise<void> {
  await page.mouse.click(1120, 850);
  await page.getByRole("button", { name: "Выделение", exact: true }).click();
  await expect.poll(() => selectedTypes(page)).toEqual([]);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 6 });
  await page.mouse.up();
}

test("selection boxes pick touched hitboxes in either direction and exclude separated objects", async ({ page, scenario }) => {
  const boardId = await scenario.createBoard("E2E пересечение хитбокса");
  await openBoard(page, boardId);
  const rectangle = canvas(page).locator("[data-layer-id] > rect");
  const ellipse = canvas(page).locator("[data-layer-id] > ellipse");

  await page.getByRole("button", { name: /^Прямоугольник/ }).click();
  await page.mouse.click(430, 340);
  await expect(rectangle).toHaveCount(1);
  await page.getByRole("button", { name: /^Эллипс/ }).click();
  await page.mouse.click(720, 460);
  await expect(ellipse).toHaveCount(1);
  await saved(page);
  // SVG geometry excludes the painted stroke included by Playwright's boundingBox.
  const rect = await hitbox(rectangle);
  const oval = await hitbox(ellipse);

  await selectBox(page, { x: rect.x - 40, y: rect.y - 40 }, { x: rect.x + 20, y: rect.y + 20 });
  await expect.poll(() => selectedTypes(page)).toEqual([LayerType.Rectangle]);

  await selectBox(page, { x: rect.x + rect.width + 40, y: rect.y + rect.height + 40 },
    { x: rect.x + rect.width - 20, y: rect.y + rect.height - 20 });
  await expect.poll(() => selectedTypes(page)).toEqual([LayerType.Rectangle]);

  await selectBox(page, { x: rect.x - 40, y: rect.y + 20 }, { x: rect.x, y: rect.y + 80 });
  await expect.poll(() => selectedTypes(page)).toEqual([LayerType.Rectangle]);

  await selectBox(page, { x: rect.x - 40, y: rect.y - 40 }, { x: rect.x, y: rect.y });
  await expect.poll(() => selectedTypes(page)).toEqual([LayerType.Rectangle]);

  await selectBox(page, { x: rect.x - 40, y: rect.y + 20 }, { x: rect.x - 1, y: rect.y + 80 });
  await expect.poll(() => selectedTypes(page)).toEqual([]);

  // This corner is outside the visible ellipse but inside its rectangular hitbox.
  await selectBox(page, { x: oval.x - 30, y: oval.y - 30 }, { x: oval.x + 5, y: oval.y + 5 });
  await expect.poll(() => selectedTypes(page)).toEqual([LayerType.Ellipse]);
  await expect.poll(() => hitbox(rectangle)).toEqual(rect);
  await saved(page);
});
