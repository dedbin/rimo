import { describe, expect, it } from "vitest";

import { edgePanVelocity, outsidePanVelocity, stepEdgePan } from "@/lib/board/auto-pan";
import type { Camera, Point } from "@/types/board-canvas";

const bounds = { left: 20, top: 30, width: 1000, height: 700 };

describe("edge auto-pan geometry", () => {
  it("leaves the center and the inner edge-zone boundary still", () => {
    expect(edgePanVelocity({ x: 520, y: 380 }, bounds)).toEqual({ x: 0, y: 0 });
    expect(edgePanVelocity({ x: 924, y: 380 }, bounds)).toEqual({ x: 0, y: 0 });
  });

  it("starts scrolling seventy-two pixels from the edge without requiring the former narrow strip", () => {
    expect(edgePanVelocity({ x: 948, y: 380 }, bounds)).toEqual({ x: 30, y: 0 });
  });

  it.each<{ point: Point; velocity: Point }>([
    { point: { x: 68, y: 380 }, velocity: { x: -120, y: 0 } },
    { point: { x: 972, y: 380 }, velocity: { x: 120, y: 0 } },
    { point: { x: 520, y: 78 }, velocity: { x: 0, y: -120 } },
    { point: { x: 520, y: 682 }, velocity: { x: 0, y: 120 } },
  ])("moves the view toward the corresponding edge at $point", ({ point, velocity }) => {
    expect(edgePanVelocity(point, bounds)).toEqual(velocity);
  });

  it("accelerates smoothly toward an edge without depending on page offset", () => {
    const halfway = edgePanVelocity({ x: 972, y: 380 }, bounds);
    const closer = edgePanVelocity({ x: 996, y: 380 }, bounds);
    expect(halfway.x).toBe(120);
    expect(closer.x).toBe(270);
    expect(edgePanVelocity({ x: 976, y: 350 }, { ...bounds, left: 0, top: 0 })).toEqual(closer);
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
  ])("keeps the inside-edge calculation zero outside the physical canvas at %o", (point) => {
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

describe("continued scrolling beyond the window", () => {
  it.each<{ point: Point; velocity: Point }>([
    { point: { x: 20, y: 380 }, velocity: { x: -480, y: 0 } },
    { point: { x: 1020, y: 380 }, velocity: { x: 480, y: 0 } },
    { point: { x: 520, y: 30 }, velocity: { x: 0, y: -480 } },
    { point: { x: 520, y: 730 }, velocity: { x: 0, y: 480 } },
    { point: { x: -100, y: 380 }, velocity: { x: -480, y: 0 } },
    { point: { x: 1200, y: 380 }, velocity: { x: 480, y: 0 } },
    { point: { x: 520, y: -100 }, velocity: { x: 0, y: -480 } },
    { point: { x: 520, y: 900 }, velocity: { x: 0, y: 480 } },
  ])("continues through the exited boundary at $point", ({ point, velocity }) => {
    expect(outsidePanVelocity(point, bounds)).toEqual(velocity);
  });

  it.each<{ point: Point; velocity: Point }>([
    { point: { x: 21, y: 380 }, velocity: { x: -480, y: 0 } },
    { point: { x: 1019, y: 380 }, velocity: { x: 480, y: 0 } },
    { point: { x: 520, y: 31 }, velocity: { x: 0, y: -480 } },
    { point: { x: 520, y: 729 }, velocity: { x: 0, y: 480 } },
  ])("uses the nearest boundary when the last native point is still inside at $point", ({ point, velocity }) => {
    expect(outsidePanVelocity(point, bounds)).toEqual(velocity);
  });

  it.each<{ point: Point; signs: Point }>([
    { point: { x: 0, y: 0 }, signs: { x: -1, y: -1 } },
    { point: { x: 1040, y: 0 }, signs: { x: 1, y: -1 } },
    { point: { x: 0, y: 750 }, signs: { x: -1, y: 1 } },
    { point: { x: 1040, y: 750 }, signs: { x: 1, y: 1 } },
    { point: { x: 20, y: 30 }, signs: { x: -1, y: -1 } },
    { point: { x: 40, y: 50 }, signs: { x: -1, y: -1 } },
  ])("limits the full diagonal speed through the corner at $point", ({ point, signs }) => {
    const velocity = outsidePanVelocity(point, bounds);
    expect(Math.sign(velocity.x)).toBe(signs.x);
    expect(Math.sign(velocity.y)).toBe(signs.y);
    expect(Math.abs(velocity.x)).toBeCloseTo(Math.abs(velocity.y));
    expect(Math.hypot(velocity.x, velocity.y)).toBeCloseTo(480);
  });

  it("uses the actual boundary even when another inside boundary is nearer", () => {
    expect(outsidePanVelocity({ x: 1021, y: 31 }, bounds)).toEqual({ x: 480, y: 0 });
  });

  it("supports offset windows and negative screen origins without mutating inputs", () => {
    const point = Object.freeze({ x: 221, y: 880 });
    const shifted = Object.freeze({ ...bounds, left: -780, top: 530 });
    expect(outsidePanVelocity(point, shifted)).toEqual({ x: 480, y: 0 });
    expect(point).toEqual({ x: 221, y: 880 });
    expect(shifted).toEqual({ left: -780, top: 530, width: 1000, height: 700 });
  });
});

describe.each([edgePanVelocity, outsidePanVelocity])("invalid auto-pan geometry for %s", (calculate) => {
  it.each([
    { point: { x: NaN, y: 380 }, rectangle: bounds },
    { point: { x: 1020, y: Infinity }, rectangle: bounds },
    { point: { x: 1020, y: 380 }, rectangle: { ...bounds, width: 0 } },
    { point: { x: 1020, y: 380 }, rectangle: { ...bounds, height: -1 } },
    { point: { x: 1020, y: 380 }, rectangle: { ...bounds, left: Infinity } },
    { point: { x: 1020, y: 380 }, rectangle: { ...bounds, top: NaN } },
  ])("ignores invalid points or bounds at $point", ({ point, rectangle }) => {
    expect(calculate(point, rectangle)).toEqual({ x: 0, y: 0 });
  });
});
