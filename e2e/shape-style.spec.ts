import { test, expect } from "./fixtures";
import { canvas, openBoard, saved } from "./board-ui";

test("shapes start unfilled and keep outline and fill independent across undo and reload", async ({ page, scenario }) => {
  const boardId = await scenario.createBoard("E2E контур и заливка");
  await openBoard(page, boardId);
  const rectangles = canvas(page).locator("[data-layer-id] > rect");
  const ellipses = canvas(page).locator("[data-layer-id] > ellipse");
  const outline = () => page.getByRole("button", { name: /^Контур:/ });
  const fill = () => page.getByRole("button", { name: /^Заливка:/ });

  await page.getByRole("button", { name: /^Прямоугольник/ }).click();
  await page.mouse.click(430, 340);
  await expect(rectangles).toHaveCount(1);
  await expect(rectangles.first()).toHaveAttribute("fill", "rgba(0,0,0,0)");
  await expect(rectangles.first()).toHaveAttribute("stroke-width", "2");
  await page.getByRole("button", { name: /^Эллипс/ }).click();
  await page.mouse.click(720, 460);
  await expect(ellipses.first()).toHaveAttribute("fill", "rgba(0,0,0,0)");

  await outline().click();
  await page.getByRole("menuitemradio", { name: "Контур: Синий", exact: true }).click();
  await fill().click();
  await page.getByRole("menuitemradio", { name: "Заливка: Жёлтый", exact: true }).click();
  await expect(ellipses.first()).toHaveAttribute("stroke", "#3b82f6");
  await expect(ellipses.first()).toHaveAttribute("fill", "#eab308");

  // Reopen the same menu immediately after changing a color.
  await fill().click();
  await expect(page.getByRole("menuitemradio", { name: "Заливка: Жёлтый", exact: true })).toHaveAttribute("aria-checked", "true");
  await page.getByRole("menuitemradio", { name: "Без заливки", exact: true }).click();
  await expect(ellipses.first()).toHaveAttribute("fill", "rgba(234,179,8,0)");
  await page.getByRole("button", { name: /^Отменить/ }).click();
  await expect(ellipses.first()).toHaveAttribute("fill", "#eab308");
  await page.getByRole("button", { name: /^Повторить/ }).click();
  await expect(ellipses.first()).toHaveAttribute("fill", "rgba(234,179,8,0)");

  await fill().click();
  await outline().click();
  await expect(page.getByRole("menu", { name: /^Контур:/ })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("menu")).toHaveCount(0);
  await expect(outline()).toBeVisible();
  await fill().click();
  await fill().click();
  await expect(page.getByRole("menu")).toHaveCount(0);

  const initial = await ellipses.first().boundingBox();
  if (!initial) throw new Error("Expected a visible ellipse");
  await page.mouse.move(initial.x + 50, initial.y + 50);
  await page.mouse.down();
  await page.mouse.move(initial.x + 90, initial.y + 70, { steps: 5 });
  await page.mouse.up();
  await expect.poll(async () => Math.round((await ellipses.first().boundingBox())!.x)).toBe(Math.round(initial.x + 40));
  await saved(page);
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(ellipses.first()).toHaveAttribute("fill", "rgba(234,179,8,0)");
  await expect(ellipses.first()).toHaveAttribute("stroke", "#3b82f6");
});
