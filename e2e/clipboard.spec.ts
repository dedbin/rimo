import sharp from "sharp";

import { test, expect } from "./fixtures";
import { canvas, copySelection, images, openBoard, pasteSelection, saved, selectAll, uploadImage } from "./board-ui";

test("copying an image to another board preserves it after the source board is deleted", async ({ page, scenario, baseURL }) => {
  const source = await scenario.createBoard("E2E изображение: источник");
  const destination = await scenario.createBoard("E2E изображение: назначение");
  await openBoard(page, source);
  await uploadImage(page, await sharp({ create: { width: 80, height: 40, channels: 4, background: "#35b779" } }).png().toBuffer());
  await expect(images(page)).toHaveCount(1);
  const original = await images(page).getAttribute("src");
  await selectAll(page);
  const copied = await copySelection(page);
  expect(copied).toContain("rimo-layers");
  await openBoard(page, destination);
  await page.mouse.move(430, 340);
  await pasteSelection(page, copied);
  await expect(images(page)).toHaveCount(1);
  const transferred = await images(page).getAttribute("src");
  expect(transferred).not.toBe(original);
  await saved(page);
  const removed = await page.request.delete(`/api/boards/${source}`, { headers: { origin: new URL(baseURL!).origin } });
  expect(removed.status()).toBe(204);
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(canvas(page)).toBeVisible();
  await saved(page);
  await expect(images(page)).toHaveCount(1);
  await expect.poll(() => images(page).evaluateAll((nodes) => nodes.every((node) => (node as HTMLImageElement).complete && (node as HTMLImageElement).naturalWidth === 80))).toBe(true);
  expect((await page.request.get(transferred!)).status()).toBe(200);
});
