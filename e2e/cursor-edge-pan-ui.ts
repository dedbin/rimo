import type { Locator, Page } from "@playwright/test";

import type { Layer, Point } from "../types/board-canvas";

import { canvas, copySelection } from "./board-ui";
import { expect } from "./fixtures";

export interface CameraView { x: number; y: number; scale: number }
export interface CameraObservation {
  first: CameraView;
  last: CameraView;
  distance: number;
  elapsed: number;
}
export type Edge = "left" | "right" | "top" | "bottom";

export const autoPan = (page: Page): Locator => page.getByRole("button", { name: "Автопрокрутка у края", exact: true });
export const layers = (page: Page): Locator => canvas(page).locator("[data-layer-id]");

export async function camera(page: Page): Promise<CameraView> {
  return canvas(page).locator('[data-board-layers="true"]').evaluate((element) => {
    const matrix = new DOMMatrixReadOnly(getComputedStyle(element).transform);
    return { x: matrix.e, y: matrix.f, scale: matrix.a };
  });
}

export async function edgePoint(page: Page, edge: Edge): Promise<Point> {
  const box = await canvas(page).boundingBox();
  if (!box) throw new Error("Expected a visible board canvas");
  // Four pixels stay clear of the floating controls, which start eight pixels in.
  return { x: box.x + (edge === "left" ? 4 : edge === "right" ? box.width - 4 : box.width / 2),
    y: box.y + (edge === "top" ? 4 : edge === "bottom" ? box.height - 4 : box.height / 2) };
}

export async function centerMouse(page: Page): Promise<void> {
  const box = await canvas(page).boundingBox();
  if (!box) throw new Error("Expected a visible board canvas");
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
}

export async function observeCamera(page: Page, duration = 240): Promise<CameraObservation> {
  return canvas(page).locator('[data-board-layers="true"]').evaluate((element, milliseconds) => {
    const read = (): CameraView => {
      const matrix = new DOMMatrixReadOnly(getComputedStyle(element).transform);
      return { x: matrix.e, y: matrix.f, scale: matrix.a };
    };
    const first = read();
    const start = performance.now();
    let distance = 0;
    return new Promise<CameraObservation>((resolve) => {
      const frame = (): void => {
        const last = read();
        distance = Math.max(distance, Math.abs(last.x - first.x), Math.abs(last.y - first.y),
          Math.abs(last.scale - first.scale) * 1000);
        const elapsed = performance.now() - start;
        if (elapsed >= milliseconds) resolve({ first, last, distance, elapsed });
        else requestAnimationFrame(frame);
      };
      requestAnimationFrame(frame);
    });
  }, duration);
}

export async function expectIdle(page: Page): Promise<void> {
  const observed = await observeCamera(page);
  expect(observed.distance, "Camera stays still throughout the observation window").toBeLessThan(1);
}

export async function expectMotion(page: Page, initial: CameraView, direction: Point, minimum = 40): Promise<void> {
  await expect.poll(async () => {
    const current = await camera(page);
    return (current.x - initial.x) * direction.x + (current.y - initial.y) * direction.y;
  }).toBeGreaterThan(minimum);
}

export async function selectedLayers(page: Page): Promise<Layer[]> {
  const copied = await copySelection(page);
  return copied ? (JSON.parse(copied) as { layers: Layer[] }).layers : [];
}

export async function screenCenter(locator: Locator): Promise<Point> {
  const box = await locator.boundingBox();
  if (!box) throw new Error("Expected a visible canvas object");
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}
