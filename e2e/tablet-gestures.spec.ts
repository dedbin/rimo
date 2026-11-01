import type { CDPSession, Page } from "@playwright/test";

import { canvas, copySelection, invitation, openBoard, saved } from "./board-ui";
import { expect, test } from "./fixtures";

interface TouchPoint { id: number; x: number; y: number }

async function touch(session: CDPSession, type: "touchStart" | "touchMove" | "touchEnd" | "touchCancel", points: TouchPoint[]): Promise<void> {
  await session.send("Input.dispatchTouchEvent", { type,
    touchPoints: points.map((point) => ({ ...point, radiusX: 5, radiusY: 5, force: 0.5 })) });
}

async function enableTouch(page: Page): Promise<CDPSession> {
  const session = await page.context().newCDPSession(page);
  await session.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
  return session;
}

async function camera(page: Page): Promise<{ x: number; y: number; scale: number }> {
  return canvas(page).locator('[data-board-layers="true"]').evaluate((element) => {
    const matrix = new DOMMatrixReadOnly(getComputedStyle(element).transform);
    return { x: matrix.e, y: matrix.f, scale: matrix.a };
  });
}

test("native two-finger pinch cancels a pencil draft, suppresses the remaining finger and preserves undo", async ({ page, scenario, browserName }) => {
  test.skip(browserName !== "chromium", "Native multitouch is driven through Chromium CDP");
  const boardId = await scenario.createBoard("E2E планшет: маркер и масштаб");
  await page.setViewportSize({ width: 1024, height: 768 });
  await openBoard(page, boardId);
  await page.getByRole("button", { name: "Маркер", exact: true }).click();
  const session = await enableTouch(page);
  try {
    await touch(session, "touchStart", [{ id: 1, x: 400, y: 300 }]);
    await touch(session, "touchMove", [{ id: 1, x: 420, y: 300 }]);
    await touch(session, "touchStart", [{ id: 1, x: 420, y: 300 }, { id: 2, x: 600, y: 300 }]);
    await touch(session, "touchMove", [{ id: 1, x: 330, y: 280 }, { id: 2, x: 690, y: 280 }]);
    await expect.poll(async () => (await camera(page)).scale).toBeCloseTo(2);
    await expect(canvas(page).locator("[data-layer-id]")).toHaveCount(0);
    await expect(page.getByRole("button", { name: /^Отменить/ })).toBeDisabled();
    const pinched = await camera(page);
    // CDP compares the active contact set; removing one point releases it.
    await touch(session, "touchMove", [{ id: 1, x: 330, y: 280 }]);
    await touch(session, "touchMove", [{ id: 1, x: 550, y: 550 }]);
    await touch(session, "touchEnd", []);
    await expect.poll(() => camera(page)).toEqual(pinched);
    await expect(canvas(page).locator("[data-layer-id]")).toHaveCount(0);
    await expect(canvas(page)).toHaveCSS("cursor", /pencil\.svg/);
    await touch(session, "touchStart", [{ id: 3, x: 500, y: 350 }]);
    await touch(session, "touchMove", [{ id: 3, x: 550, y: 400 }]);
    await touch(session, "touchEnd", []);
    await expect(canvas(page).locator("[data-layer-id]")).toHaveCount(1);
    await saved(page);
    await page.getByRole("button", { name: /^Отменить/ }).click();
    await expect(canvas(page).locator("[data-layer-id]")).toHaveCount(0);
    await expect(page.getByRole("button", { name: /^Отменить/ })).toBeDisabled();
    await saved(page);
  } finally { await touch(session, "touchCancel", []).catch(() => {}); await session.detach(); }
});

test("pinch over a selected layer and its resize handle changes only the camera, including for a viewer", async ({ page, scenario, browserName }) => {
  test.skip(browserName !== "chromium", "Native multitouch is driven through Chromium CDP");
  const boardId = await scenario.createBoard("E2E планшет: выделение и просмотр");
  await page.setViewportSize({ width: 1024, height: 768 });
  await openBoard(page, boardId);
  await page.getByRole("button", { name: /^Прямоугольник/ }).click();
  await page.mouse.click(400, 300);
  await page.keyboard.press("Escape");
  await page.mouse.click(450, 350);
  const original = await copySelection(page);
  expect(original).not.toBe("");
  const handle = await canvas(page).locator("rect.fill-white").first().boundingBox();
  if (!handle) throw new Error("Expected a selected rectangle resize handle");
  const corner = { id: 2, x: handle.x + handle.width / 2, y: handle.y + handle.height / 2 };
  const session = await enableTouch(page);
  try {
    await touch(session, "touchStart", [{ id: 1, x: 450, y: 350 }]);
    await touch(session, "touchStart", [{ id: 1, x: 450, y: 350 }, corner]);
    await touch(session, "touchMove", [{ id: 1, x: 475, y: 375 }, { ...corner, x: corner.x - 25, y: corner.y - 25 }]);
    await touch(session, "touchEnd", []);
    await expect.poll(async () => (await camera(page)).scale).toBeGreaterThan(1);
    expect(await copySelection(page)).toBe(original);
    await saved(page);
  } finally { await touch(session, "touchCancel", []).catch(() => {}); await session.detach(); }

  const viewer = await scenario.guest(await invitation(page, "viewer"), "Планшет: просмотр");
  const viewerSession = await enableTouch(viewer);
  const ownerCamera = await camera(page);
  try {
    await touch(viewerSession, "touchStart", [{ id: 1, x: 400, y: 300 }, { id: 2, x: 600, y: 300 }]);
    await touch(viewerSession, "touchMove", [{ id: 1, x: 450, y: 340 }, { id: 2, x: 650, y: 340 }]);
    await touch(viewerSession, "touchEnd", []);
    await expect.poll(() => camera(viewer)).toEqual({ x: 50, y: 40, scale: 1 });
    expect(await camera(page)).toEqual(ownerCamera);
    expect(await copySelection(page)).toBe(original);
    await saved(viewer);
  } finally { await touch(viewerSession, "touchCancel", []).catch(() => {}); await viewerSession.detach(); }
});
