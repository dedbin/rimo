import { describe, expect, it } from "vitest";

import { createGraphSettings, parseGraphViewport } from "@/lib/board/graph/model";
import { cleanGraphCoordinate, cleanGraphViewport, stepGraphViewport } from "@/lib/board/graph/viewport-numbers";
import type { GraphViewport } from "@/types/board-canvas";

describe("graph viewport decimal noise", () => {
  it("cleans machine noise without rounding deliberate precision", () => {
    expect(cleanGraphCoordinate(5.120000000000001)).toBe(5.12);
    expect(cleanGraphCoordinate(-3.5200000000000005)).toBe(-3.52);
    expect(Object.is(cleanGraphCoordinate(-0), 0)).toBe(true);
    for (const precise of [Math.PI, 0.12345678901234566, 999999.123456789, 1e-12]) {
      expect(cleanGraphCoordinate(precise)).toBe(precise);
    }
  });

  it("returns exactly after several and a thousand inverse zoom steps", () => {
    const original = createGraphSettings().viewport;
    let current: GraphViewport = { ...original };
    for (let index = 0; index < 3; index += 1) current = stepGraphViewport(current, 0.8)!;
    for (let index = 0; index < 3; index += 1) current = stepGraphViewport(current, 1.25)!;
    expect(current).toEqual(original);
    for (let index = 0; index < 1000; index += 1) {
      current = stepGraphViewport(stepGraphViewport(current, 0.8)!, 1.25)!;
    }
    expect(current).toEqual(original);
    expect(original).toEqual({ xMin: -8, xMax: 8, yMin: -5.5, yMax: 5.5 });
  });

  it("preserves a narrow range and deliberate offset without mutating input", () => {
    const value = { xMin: 999999.123456789, xMax: 999999.123556791, yMin: -0.0000500009, yMax: 0.0000500009 };
    const original = { ...value };
    expect(parseGraphViewport(value)).not.toBeNull();
    expect(cleanGraphViewport(value)).toEqual(value);
    expect(value).toEqual(original);
    expect(parseGraphViewport(stepGraphViewport(value, 1.25))).not.toBeNull();
    expect(stepGraphViewport(value, 0.8)).toBeNull();
  });
});
