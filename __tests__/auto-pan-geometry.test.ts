import { describe, expect, it } from "vitest";

import { edgePanVelocity, stepEdgePan } from "@/lib/board/auto-pan";
import type { Camera, Point } from "@/types/board-canvas";

const bounds = { left: 20, top: 30, width: 1000, height: 700 };

describe("edge auto-pan geometry", () => {
  it("leaves the center and the inner edge-zone boundary still", () => {
    expect(edgePanVelocity({ x: 520, y: 380 }, bounds)).toEqual({ x: 0, y: 0 });
    expect(edgePanVelocity({ x: 972, y: 380 }, bounds)).toEqual({ x: 0, y: 0 });
  });

  it.each<{ point: Point; velocity: Point }>([
    { point: { x: 44, y: 380 }, velocity: { x: -120, y: 0 } },
    { point: { x: 996, y: 380 }, velocity: { x: 120, y: 0 } },
    { point: { x: 520, y: 54 }, velocity: { x: 0, y: -120 } },
    { point: { x: 520, y: 706 }, velocity: { x: 0, y: 120 } },
  ])("moves the view toward the corresponding edge at $point", ({ point, velocity }) => {
    expect(edgePanVelocity(point, bounds)).toEqual(velocity);
  });

  it("accelerates smoothly toward an edge without depending on page offset", () => {
    const halfway = edgePanVelocity({ x: 996, y: 380 }, bounds);
    const closer = edgePanVelocity({ x: 1008, y: 380 }, bounds);
    expect(halfway.x).toBe(120);
    expect(closer.x).toBe(270);
    expect(edgePanVelocity({ x: 988, y: 350 }, { ...bounds, left: 0, top: 0 })).toEqual(closer);
  });

  it("caps diagonal motion at the same speed as a single edge", () => {
    const velocity = edgePanVelocity({ x: 20.1, y: 30.1 }, bounds);
    expect(velocity.x).toBeLessThan(0);
    expect(velocity.y).toBeLessThan(0);
    expect(velocity.x).toBeCloseTo(velocity.y);
    expect(Math.hypot(velocity.x, velocity.y)).toBeCloseTo(480);
  });

  it.each<Point>([
    { x: 19, y: 380 }, { x: 1021, y: 380 },
    { x: 520, y: 29 }, { x: 520, y: 731 },
  ])("does not keep scrolling outside the physical canvas at %o", (point) => {
    expect(edgePanVelocity(point, bounds)).toEqual({ x: 0, y: 0 });
  });

  it.each([0.1, 1, 4])("keeps screen speed and zoom at scale %s", (scale) => {
    const camera: Camera = Object.freeze({ x: 40, y: -30, scale });
    const velocity = Object.freeze({ x: 120, y: -120 });
    const next = stepEdgePan(camera, velocity, 16);
    expect(next).toEqual({ x: 38.08, y: -28.08, scale });
    expect(camera).toEqual({ x: 40, y: -30, scale });
    expect(velocity).toEqual({ x: 120, y: -120 });
  });

  it("caps a delayed frame instead of jumping after a stalled animation loop", () => {
    expect(stepEdgePan({ x: 40, y: -30, scale: 2 }, { x: 120, y: -120 }, 1000))
      .toEqual({ x: 36.16, y: -26.16, scale: 2 });
    expect(stepEdgePan({ x: 40, y: -30, scale: 2 }, { x: 120, y: -120 }, 0))
      .toEqual({ x: 40, y: -30, scale: 2 });
  });
});
