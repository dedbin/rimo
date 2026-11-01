import { readFile } from "node:fs/promises";

import type { Locator, Page } from "@playwright/test";

import type { LineLayer, PathLayer } from "@/types/board-canvas";

import { canvas, copySelection, invitation, openBoard, pasteSelection, saved, selectAll } from "./board-ui";
import { expect, test } from "./fixtures";

const paths = (page: Page): Locator => canvas(page).locator("[data-layer-id] path.drop-shadow-md");
const lines = (page: Page): Locator => canvas(page).locator('[data-line-body="true"]');

async function drag(page: Page, y: number): Promise<void> {
  await page.mouse.move(430, y);
  await page.mouse.down();
  await page.mouse.move(680, y, { steps: 10 });
  await page.mouse.up();
}

async function marker(page: Page, opacity: number): Promise<void> {
  await page.getByRole("button", { name: "Настройки маркера", exact: true }).click();
  await page.getByRole("menuitemradio", { name: `Непрозрачность маркера: ${opacity}%`, exact: true }).click();
  await page.getByRole("menuitemradio", { name: "Цвет маркера: Синий", exact: true }).click();
  await page.getByRole("menuitemradio", { name: "Толщина маркера: 24 пкс", exact: true }).click();
  await expect(page.getByRole("menuitemradio", { name: `Непрозрачность маркера: ${opacity}%`, exact: true })).toHaveAttribute("aria-checked", "true");
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Маркер", exact: true }).click();
}

async function dashedSegment(page: Page, y: number): Promise<void> {
  await page.getByRole("button", { name: "Линии", exact: true }).click();
  await page.getByRole("menuitemradio", { name: "Пунктирная", exact: true }).click();
  await page.getByRole("menuitemradio", { name: "Отрезок", exact: true }).click();
  await drag(page, y);
}

test("marker opacity matches live remote drafts and survives undo, reload and clipboard while staying personal", async ({ page, scenario }) => {
  const source = await scenario.createBoard("E2E v0.3: прозрачный маркер");
  await openBoard(page, source);
  const guest = await scenario.guest(await invitation(page, "editor"), "Прозрачность ученика");
  await marker(page, 50);
  await page.mouse.move(430, 330);
  await page.mouse.down();
  try {
    await page.mouse.move(680, 330, { steps: 10 });
    await expect(canvas(page).locator("[data-layer-id]")).toHaveCount(0);
    await expect(canvas(guest).locator("[data-layer-id]")).toHaveCount(0);
    await expect(canvas(page).locator("path.drop-shadow-md")).toHaveAttribute("fill", "rgba(59,130,246,0.5)");
    await expect(canvas(guest).locator("path.drop-shadow-md")).toHaveAttribute("fill", "rgba(59,130,246,0.5)");
  } finally { await page.mouse.up(); }
  await expect(paths(page)).toHaveCount(1);
  await expect(paths(guest)).toHaveAttribute("fill", "rgba(59,130,246,0.5)");
  await page.getByRole("button", { name: /^Отменить/ }).click();
  await expect(paths(page)).toHaveCount(0);
  await expect(paths(guest)).toHaveCount(0);
  await page.getByRole("button", { name: /^Повторить/ }).click();
  await expect(paths(page)).toHaveCount(1);
  await expect(paths(guest)).toHaveAttribute("fill", "rgba(59,130,246,0.5)");

  await guest.getByRole("button", { name: "Настройки маркера", exact: true }).click();
  await expect(guest.getByRole("menuitemradio", { name: "Непрозрачность маркера: 100%", exact: true })).toHaveAttribute("aria-checked", "true");
  await guest.keyboard.press("Escape");
  await saved(page);
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(paths(page)).toHaveAttribute("fill", "rgba(59,130,246,0.5)");
  await page.getByRole("button", { name: "Настройки маркера", exact: true }).click();
  await expect(page.getByRole("menuitemradio", { name: "Непрозрачность маркера: 50%", exact: true })).toHaveAttribute("aria-checked", "true");
  await expect(page.getByRole("menuitemradio", { name: "Цвет маркера: Синий", exact: true })).toHaveAttribute("aria-checked", "true");
  await expect(page.getByRole("menuitemradio", { name: "Толщина маркера: 24 пкс", exact: true })).toHaveAttribute("aria-checked", "true");
  await page.keyboard.press("Escape");
  await selectAll(page);
  const copied = await copySelection(page);
  const payload = JSON.parse(copied) as { layers: PathLayer[] };
  expect(payload.layers).toHaveLength(1);
  expect(payload.layers[0]).toMatchObject({ fill: { r: 59, g: 130, b: 246, a: 0.5 }, size: 24 });
  await openBoard(page, await scenario.createBoard("E2E v0.3: перенос полупрозрачного штриха"));
  await page.mouse.move(500, 400);
  await pasteSelection(page, copied);
  await expect(paths(page)).toHaveAttribute("fill", "rgba(59,130,246,0.5)");
  await saved(page);
});

test("dashed segments preserve solid arrowheads, shared style changes, undo, reload and clipboard", async ({ page, scenario }) => {
  const boardId = await scenario.createBoard("E2E v0.3: пунктирные линии");
  await openBoard(page, boardId);
  const guest = await scenario.guest(await invitation(page, "editor"), "Пунктир ученика");
  await dashedSegment(page, 420);
  await expect(lines(page)).toHaveCount(1);
  await expect(lines(page)).toHaveAttribute("data-line-style", "dashed");
  await expect(lines(page)).toHaveAttribute("stroke-dasharray", /\d/);
  await expect(lines(guest)).toHaveAttribute("data-line-style", "dashed");
  await page.getByRole("button", { name: "Выделение", exact: true }).click();
  await page.mouse.click(520, 420);
  await page.getByRole("button", { name: "Стрелка в начале", exact: true }).click();
  await page.getByRole("button", { name: "Стрелка в конце", exact: true }).click();
  await expect(canvas(guest).locator("[data-line-arrow]")).toHaveCount(2);
  await expect(canvas(page).locator("[data-line-arrow]").first()).not.toHaveAttribute("stroke-dasharray", /\S/);
  await page.getByRole("button", { name: /^Стиль линии:/ }).click();
  await page.getByRole("menuitemradio", { name: "Сплошная", exact: true }).click();
  await expect(lines(guest)).toHaveAttribute("data-line-style", "solid");
  await expect(lines(page)).not.toHaveAttribute("stroke-dasharray", /\S/);
  await page.getByRole("button", { name: /^Отменить/ }).click();
  await expect(lines(guest)).toHaveAttribute("data-line-style", "dashed");
  await page.getByRole("button", { name: /^Повторить/ }).click();
  await expect(lines(guest)).toHaveAttribute("data-line-style", "solid");
  await page.getByRole("button", { name: /^Стиль линии:/ }).click();
  await page.getByRole("menuitemradio", { name: "Пунктирная", exact: true }).click();
  await saved(page);
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(lines(page)).toHaveAttribute("data-line-style", "dashed");
  await expect(lines(page)).toHaveAttribute("stroke-dasharray", /\d/);
  await expect(canvas(page).locator("[data-line-arrow]")).toHaveCount(2);
  await selectAll(page);
  const copied = await copySelection(page);
  const payload = JSON.parse(copied) as { layers: LineLayer[] };
  expect(payload.layers).toHaveLength(1);
  expect(payload.layers[0]).toMatchObject({ strokeStyle: "dashed", lineKind: "segment", startArrow: true, endArrow: true });
  await openBoard(page, await scenario.createBoard("E2E v0.3: перенос пунктирной линии"));
  await pasteSelection(page, copied);
  await expect(lines(page)).toHaveAttribute("data-line-style", "dashed");
  await expect(canvas(page).locator("[data-line-arrow]")).toHaveCount(2);
  await saved(page);
});

test("mixed marker and dashed line styles survive real PDF export and portable archive import", async ({ page, scenario }, info) => {
  test.setTimeout(120_000);
  const boardId = await scenario.createBoard("E2E v0.3: оформление в PDF и архиве");
  await openBoard(page, boardId);
  await marker(page, 25);
  await drag(page, 330);
  await dashedSegment(page, 500);
  await expect(paths(page)).toHaveAttribute("fill", "rgba(59,130,246,0.25)");
  await expect(lines(page)).toHaveAttribute("data-line-style", "dashed");
  await saved(page);
  await selectAll(page);
  await page.getByRole("button", { name: "PDF", exact: true }).click();
  const prepared = page.waitForResponse((response) => new URL(response.url()).pathname.endsWith("/pdf/preview") && response.request().method() === "POST");
  await page.getByRole("button", { name: "Создать предпросмотр", exact: true }).click();
  expect((await prepared).status()).toBe(201);
  const preview = page.frameLocator('iframe[title^="Предпросмотр:"]');
  await expect(preview.locator('svg line[stroke-dasharray]')).toHaveCount(1);
  await expect(preview.locator('svg path[fill="rgba(59,130,246,0.25)"]')).toHaveCount(1);
  const acceptance = page.getByLabel("Я проверил масштаб и границы всех страниц", { exact: true });
  if (await acceptance.count()) await acceptance.check();
  const pdfEvent = page.waitForEvent("download");
  await page.getByRole("button", { name: "Скачать PDF", exact: true }).click();
  const pdf = await pdfEvent;
  const pdfPath = info.outputPath("v03-styles.pdf");
  await pdf.saveAs(pdfPath);
  expect((await readFile(pdfPath)).subarray(0, 5).toString()).toBe("%PDF-");
  await page.keyboard.press("Escape");

  const archiveEvent = page.waitForEvent("download");
  await page.getByRole("button", { name: "Действия с доской", exact: true }).click();
  await page.getByRole("button", { name: "Архив", exact: true }).click();
  const archivePath = info.outputPath("v03-styles.rimo");
  await (await archiveEvent).saveAs(archivePath);
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Действия с доской", exact: true }).click();
  const imported = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/boards/import" && response.request().method() === "POST");
  await page.getByLabel("Архив Rimo", { exact: true }).setInputFiles(archivePath);
  expect((await imported).status()).toBe(201);
  await page.waitForURL((url) => /^\/board\/[a-f0-9-]{36}$/.test(url.pathname) && url.pathname !== `/board/${boardId}`);
  scenario.createdBoards.add(new URL(page.url()).pathname.split("/").at(-1)!);
  await saved(page);
  await expect(paths(page)).toHaveAttribute("fill", "rgba(59,130,246,0.25)");
  await expect(lines(page)).toHaveAttribute("data-line-style", "dashed");
  await expect(lines(page)).toHaveAttribute("stroke-dasharray", /\d/);
});
