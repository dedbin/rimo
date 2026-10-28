import { test, expect } from "./fixtures";
import { canvas, finishText, insertText, invitation, openBoard, saved } from "./board-ui";

test("active editor becomes viewer and editor again without reload, cancelling text and a pending gesture", async ({ page, context, baseURL, scenario }) => {
  const boardId = await scenario.createBoard("E2E изменение прав");
  await openBoard(page, boardId);
  const student = await scenario.guest(await invitation(page, "editor"), "E2E смена роли");
  const origin = new URL(baseURL!).origin;
  const userId = (await (await student.request.get("/api/auth/get-session")).json() as { user: { id: string } }).user.id;
  const change = async (role: "editor" | "viewer") => {
    const response = await context.request.patch(`/api/boards/${boardId}/members/${userId}`, {
      headers: { origin }, data: { role },
    });
    expect(response.status()).toBe(204);
  };
  const studentLocation = student.url();
  await insertText(student, "Условие сохраняется");
  await saved(student);
  await change("viewer");
  await expect(student.getByText("Только просмотр", { exact: true })).toBeVisible({ timeout: 10_000 });
  await expect(student.getByRole("textbox", { name: "Текст на доске", exact: true })).toHaveCount(0);
  await expect(student.getByRole("button", { name: /^Прямоугольник/ })).toHaveCount(0);
  await expect(student).toHaveURL(studentLocation);
  // A viewer keeps receiving the teacher's independent edits.
  await page.getByRole("button", { name: /^Прямоугольник/ }).click();
  await page.mouse.click(820, 270);
  const teacherRectangle = canvas(page).locator("[data-layer-id] > rect");
  await expect(teacherRectangle).toHaveCount(1);
  await expect(canvas(student).locator("[data-layer-id] > rect")).toHaveCount(1);
  await saved(page);
  const initial = await teacherRectangle.boundingBox();
  if (!initial) throw new Error("Fixture rectangle missing");
  await change("editor");
  await expect(student.getByRole("button", { name: /^Эллипс/ })).toBeVisible({ timeout: 10_000 });
  await expect(student.getByText("Только просмотр", { exact: true })).toHaveCount(0);
  await student.getByRole("button", { name: /^Эллипс/ }).click();
  await student.mouse.click(700, 520);
  await expect(canvas(page).locator("ellipse")).toHaveCount(1);
  await saved(student);
  await student.getByRole("button", { name: "Выделение", exact: true }).click();
  await student.mouse.move(initial.x + 20, initial.y + 20);
  await student.mouse.down();
  await student.mouse.move(initial.x + 140, initial.y + 100, { steps: 4 });
  await change("viewer");
  await expect(student.getByText("Только просмотр", { exact: true })).toBeVisible({ timeout: 10_000 });
  // Remote selection can widen the outline; compare the object's center.
  const initialCenterX = Math.round(initial.x + initial.width / 2);
  await expect.poll(async () => {
    const bounds = await canvas(student).locator("[data-layer-id] > rect").boundingBox();
    return bounds ? Math.round(bounds.x + bounds.width / 2) : -1;
  }).toBe(initialCenterX);
  await change("editor");
  await expect(student.getByRole("button", { name: /^Прямоугольник/ })).toBeVisible({ timeout: 10_000 });
  await student.mouse.up();
  await finishText(student);
  await expect.poll(async () => {
    const bounds = await teacherRectangle.boundingBox();
    return bounds ? Math.round(bounds.x + bounds.width / 2) : -1;
  }).toBe(initialCenterX);
  await expect(canvas(page).getByText("Условие сохраняется", { exact: true })).toBeVisible();
  await expect(student).toHaveURL(studentLocation);
});
