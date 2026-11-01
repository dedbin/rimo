import type { Locator, Page } from "@playwright/test";

import { canvas, copySelection, invitation, openBoard, saved, selectAll } from "./board-ui";
import { expect, test } from "./fixtures";

import type { PathLayer } from "@/types/board-canvas";

const paths = (page: Page): Locator => canvas(page).locator("[data-layer-id] path");

async function settings(page: Page, color: string, size: number): Promise<void> {
  await page.getByRole("button", { name: "Настройки маркера", exact: true }).click();
  await page.getByRole("menuitemradio", { name: `Цвет маркера: ${color}`, exact: true }).click();
  await page.getByRole("menuitemradio", { name: `Толщина маркера: ${size} пкс`, exact: true }).click();
  await page.keyboard.press("Escape");
}

async function draw(page: Page, y: number): Promise<void> {
  await page.getByRole("button", { name: "Маркер", exact: true }).click();
  await expect(page.getByRole("menu", { name: "Настройки маркера", exact: true })).toHaveCount(0);
  await page.mouse.move(430, y);
  await page.mouse.down();
  await page.mouse.move(620, y, { steps: 10 });
  await page.mouse.up();
}

test("marker choices are personal, precede drawing and survive tool changes and reload", async ({ page, scenario }) => {
  const boardId = await scenario.createBoard("E2E личные настройки маркера");
  await openBoard(page, boardId);
  const guest = await scenario.guest(await invitation(page, "editor"), "Ученик с синим маркером");

  await settings(page, "Чёрный", 4);
  await draw(page, 330);
  await expect(paths(page)).toHaveCount(1);
  await expect(paths(guest)).toHaveCount(1);
  await settings(guest, "Синий", 24);
  await draw(guest, 430);
  await expect(paths(page)).toHaveCount(2);
  await expect(paths(page).nth(1)).toHaveAttribute("fill", "#3b82f6");

  await page.getByRole("button", { name: /^Ластик/ }).click();
  await draw(page, 530);
  await expect(paths(page)).toHaveCount(3);
  await expect(paths(guest)).toHaveCount(3);
  await expect(paths(page).nth(2)).toHaveAttribute("fill", "#000000");

  // Editing an existing shared stroke still changes the object for both peers.
  await guest.getByRole("button", { name: "Выделение", exact: true }).click();
  await guest.mouse.click(520, 330);
  await guest.getByRole("toolbar").getByRole("button").filter({ has: guest.locator('[style*="239, 68, 68"]') }).click();
  await expect(paths(page).first()).toHaveAttribute("fill", "#ef4444");
  await expect(paths(guest).first()).toHaveAttribute("fill", "#ef4444");

  await saved(page);
  await saved(guest);
  await guest.reload({ waitUntil: "domcontentloaded" });
  await expect(canvas(guest)).toBeVisible();
  await guest.getByRole("button", { name: "Настройки маркера", exact: true }).click();
  await expect(guest.getByRole("menuitemradio", { name: "Цвет маркера: Синий", exact: true })).toHaveAttribute("aria-checked", "true");
  await expect(guest.getByRole("menuitemradio", { name: "Толщина маркера: 24 пкс", exact: true })).toHaveAttribute("aria-checked", "true");
  await guest.keyboard.press("Escape");

  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(canvas(page)).toBeVisible();
  await draw(page, 630);
  await expect(paths(page)).toHaveCount(4);
  await expect(paths(page).last()).toHaveAttribute("fill", "#000000");
  await selectAll(page);
  const copied = JSON.parse(await copySelection(page)) as { layers: PathLayer[] };
  expect(copied.layers.map(({ fill, size }) => ({ fill, size }))).toEqual([
    { fill: { r: 239, g: 68, b: 68 }, size: 4 },
    { fill: { r: 59, g: 130, b: 246 }, size: 24 },
    { fill: { r: 0, g: 0, b: 0 }, size: 4 },
    { fill: { r: 0, g: 0, b: 0 }, size: 4 },
  ]);
  await saved(page);
});

test("marker settings stay inside a narrow viewport", async ({ page, scenario }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openBoard(page, await scenario.createBoard("E2E настройки маркера на узком экране"));
  await page.getByRole("button", { name: "Настройки маркера", exact: true }).click();
  const menu = page.getByRole("menu", { name: "Настройки маркера", exact: true });
  await expect(menu).toBeVisible();
  const bounds = await menu.boundingBox();
  expect(bounds).not.toBeNull();
  if (!bounds) throw new Error("Marker menu has no visible bounds");
  expect(bounds.x).toBeGreaterThanOrEqual(0);
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(390);
  expect(bounds.y).toBeGreaterThanOrEqual(0);
  expect(bounds.y + bounds.height).toBeLessThanOrEqual(844);
  await page.getByRole("menuitemradio", { name: "Цвет маркера: Синий", exact: true }).click();
  await page.getByRole("menuitemradio", { name: "Толщина маркера: 24 пкс", exact: true }).click();
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Маркер", exact: true }).click();
  await expect(menu).toHaveCount(0);
});
