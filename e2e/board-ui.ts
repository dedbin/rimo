import { expect } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";

export const canvas = (page: Page): Locator => page.locator('svg[aria-label="Холст доски"]');
export const texts = (page: Page): Locator => canvas(page).locator("[data-board-text-id]");
export const images = (page: Page): Locator => canvas(page).locator('img[alt^="Превью слоя "]');
export async function saved(page: Page): Promise<void> { await expect(page.getByText("Сохранено", { exact: true })).toBeVisible(); }
export async function openBoard(page: Page, id: string): Promise<void> {
  await page.goto(`/board/${id}`, { waitUntil: "networkidle" });
  await expect(canvas(page)).toBeVisible();
  await saved(page);
}
export async function invitation(page: Page, role: "editor" | "viewer"): Promise<string> {
  await page.getByRole("button", { name: "Поделиться", exact: true }).click();
  await page.getByLabel("Права по приглашению", { exact: true }).selectOption(role);
  await page.getByRole("button", { name: "Создать ссылку", exact: true }).click();
  const input = page.getByLabel("Ссылка-приглашение", { exact: true });
  await expect(input).not.toHaveValue("");
  const result = await input.inputValue();
  await page.keyboard.press("Escape");
  return result;
}
export async function insertText(page: Page, value: string): Promise<Locator> {
  const count = await texts(page).count();
  await page.getByRole("button", { name: /^Текст \(/ }).click();
  await page.mouse.click(430, 340);
  await expect(texts(page)).toHaveCount(count + 1);
  const block = texts(page).nth(count);
  await block.dblclick();
  const editor = page.getByRole("textbox", { name: "Текст на доске", exact: true });
  await expect(editor).toBeVisible();
  await editor.pressSequentially(value);
  return block;
}
export async function finishText(page: Page): Promise<void> { await page.mouse.click(1120, 870); await saved(page); }
export async function selectAll(page: Page): Promise<void> {
  await page.mouse.click(1300, 750);
  await page.getByRole("button", { name: "Выделение", exact: true }).click();
  await page.mouse.move(70, 80);
  await page.mouse.down();
  await page.mouse.move(1370, 950, { steps: 6 });
  await page.mouse.up();
}
export async function uploadImage(page: Page, png: Buffer): Promise<void> {
  const before = await images(page).count();
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "Изображение", exact: true }).click();
  await (await chooser).setFiles({ name: "e2e-image.png", mimeType: "image/png", buffer: png });
  await expect(images(page)).toHaveCount(before + 1);
  await expect.poll(() => images(page).evaluateAll((nodes) => nodes.every((node) => (node as HTMLImageElement).complete && (node as HTMLImageElement).naturalWidth > 0))).toBe(true);
  await saved(page);
}
export async function copySelection(page: Page): Promise<string> {
  return page.evaluate(() => {
    const data = new DataTransfer();
    window.dispatchEvent(new ClipboardEvent("copy", { clipboardData: data, bubbles: true, cancelable: true }));
    return data.getData("application/x-rimo-layers+json");
  });
}
export async function pasteSelection(page: Page, payload: string): Promise<void> {
  await page.evaluate((value) => {
    const data = new DataTransfer();
    data.setData("application/x-rimo-layers+json", value);
    window.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
  }, payload);
}
