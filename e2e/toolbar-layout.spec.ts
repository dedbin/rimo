import type { Locator, Page } from "@playwright/test";

import { side } from "@/types/board-canvas";

import { canvas, openBoard, saved } from "./board-ui";
import { expect, test } from "./fixtures";

const toolbar = (page: Page): Locator => page.getByRole("button", { name: "Выделение", exact: true }).locator("xpath=../..");

async function expectControlsInsideViewport(page: Page): Promise<void> {
  const bounds = await toolbar(page).getByRole("button").evaluateAll((buttons) => buttons.map((button) => {
    const box = button.getBoundingClientRect();
    const x = box.left + box.width / 2;
    const y = box.top + box.height / 2;
    return { label: button.getAttribute("aria-label"), top: box.top, bottom: box.bottom,
      left: box.left, right: box.right, width: box.width, height: box.height,
      visible: button.hasAttribute("disabled") || button.contains(document.elementFromPoint(x, y)) };
  }));
  const viewport = page.viewportSize()!;
  for (const control of bounds) {
    expect(control.top, `${control.label}: below header`).toBeGreaterThanOrEqual(64);
    expect(control.bottom, `${control.label}: above save status`).toBeLessThanOrEqual(viewport.height - 48);
    expect(control.left, `${control.label}: left edge`).toBeGreaterThanOrEqual(0);
    expect(control.right, `${control.label}: right edge`).toBeLessThanOrEqual(viewport.width);
    expect(control.width, `${control.label}: target width`).toBeGreaterThanOrEqual(36);
    expect(control.height, `${control.label}: target height`).toBeGreaterThanOrEqual(36);
    expect(control.visible, `${control.label}: no overlapping controls`).toBe(true);
  }
  await expect(canvas(page)).toHaveJSProperty("clientHeight", viewport.height);
  expect(await page.evaluate(() => document.documentElement.scrollHeight)).toBe(viewport.height);
}

test("board controls fit landscape and portrait tablets without shrinking buttons", async ({ page, scenario }, info) => {
  await openBoard(page, await scenario.createBoard("E2E планшет: вместимость панелей"));
  for (const viewport of [
    { width: 1280, height: 657 }, // Tablet screenshot minus the browser's top bar.
    { width: 1024, height: 600 },
    { width: 1280, height: 720 },
    { width: 1024, height: 779 },
    { width: 1024, height: 780 },
    { width: 768, height: 1024 },
    { width: 390, height: 844 },
    { width: 1440, height: 1000 },
  ]) {
    await page.setViewportSize(viewport);
    await expectControlsInsideViewport(page);
  }
  await page.setViewportSize({ width: 1280, height: 657 });
  const screenshot = info.outputPath("tablet-toolbar.png");
  await page.screenshot({ path: screenshot });
  await info.attach("tablet-toolbar", { path: screenshot, contentType: "image/png" });
  await page.getByRole("button", { name: "Настройки маркера", exact: true }).click();
  await expect(page.getByRole("menu", { name: "Настройки маркера", exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Лазерная указка", exact: true }).click();
  await expect(page.getByText("Удерживайте нажатие, чтобы показать указку", { exact: true })).toHaveCount(0);
});

test("short landscape screens keep history visible and let tools scroll without moving the board", async ({ page, scenario, browserName }) => {
  test.skip(browserName !== "chromium", "Native touch scrolling is driven through Chromium CDP");
  await page.setViewportSize({ width: 844, height: 390 });
  await openBoard(page, await scenario.createBoard("E2E планшет: прокрутка инструментов"));
  const controls = toolbar(page);
  const tools = controls.locator(":scope > div").first();
  const undo = page.getByRole("button", { name: /^Отменить/ });
  const undoBefore = await undo.boundingBox();
  expect(undoBefore!.y + undoBefore!.height).toBeLessThan(390 - 48);
  const transform = await canvas(page).locator('[data-board-layers="true"]').getAttribute("style");
  const session = await page.context().newCDPSession(page);
  await session.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
  try {
    const box = (await tools.boundingBox())!;
    const x = box.x + box.width / 2;
    const start = box.y + box.height - 12;
    await session.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ id: 1, x, y: start }] });
    for (let step = 1; step <= 8; step++) {
      await session.send("Input.dispatchTouchEvent", { type: "touchMove",
        touchPoints: [{ id: 1, x, y: start - step * (box.height - 24) / 8 }] });
    }
    await session.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await expect.poll(() => tools.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
    await expect.poll(() => tools.evaluate((element) => {
      const buttons = element.querySelectorAll("button");
      const lastButton = buttons[buttons.length - 1];
      const rect = lastButton!.getBoundingClientRect();
      return lastButton!.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2));
    })).toBe(true);
    expect(await undo.boundingBox()).toEqual(undoBefore);
    await expect(canvas(page).locator('[data-board-layers="true"]')).toHaveAttribute("style", transform!);
  } finally {
    await session.send("Input.dispatchTouchEvent", { type: "touchCancel", touchPoints: [] }).catch(() => {});
    await session.detach();
  }
});

test("compact toolbar leaves the graph resize handle accessible beside its editor", async ({ page, scenario }) => {
  await page.setViewportSize({ width: 1024, height: 768 });
  await openBoard(page, await scenario.createBoard("E2E планшет: ручки графика"));
  await page.getByRole("button", { name: "График", exact: true }).click();
  await page.mouse.click(300, 220);
  const graph = canvas(page).locator('[data-graph-layer="true"]');
  const editor = page.getByRole("complementary", { name: "Редактор графика", exact: true });
  await expect(editor).toBeVisible();
  const panel = (await editor.boundingBox())!;
  // Wait for autofocus to put the plot beside the editor before checking overlap.
  await expect.poll(async () => {
    const box = (await graph.boundingBox())!;
    return box.x + box.width;
  }).toBeLessThanOrEqual(panel.x);
  const handle = canvas(page).locator(`[data-resize-handle="${side.left}"]`);
  await expect.poll(() => handle.evaluate((element) => {
    const box = element.getBoundingClientRect();
    return element.parentElement!.contains(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2));
  })).toBe(true);
  const before = (await graph.boundingBox())!;
  const box = (await handle.boundingBox())!;
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  try { await page.mouse.move(x + 32, y, { steps: 6 }); }
  finally { await page.mouse.up(); }
  await expect.poll(async () => (await graph.boundingBox())!.width).toBeLessThan(before.width - 20);
  await saved(page);
});
