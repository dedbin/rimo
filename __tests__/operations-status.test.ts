import { describe, expect, it } from "vitest";
import { storageSpaceHealth } from "../server/operations/status";

const MiB = 1024 * 1024;
const GiB = 1024 * MiB;
describe("operator disk reserve thresholds", () => {
  it("warns at exactly 80 percent occupied and below that remaining reserve", () => {
    expect(storageSpaceHealth(3 * GiB, 10 * GiB)).toBeNull();
    expect(storageSpaceHealth(8 * GiB + 1, 40 * GiB)).toBeNull();
    expect(storageSpaceHealth(8 * GiB, 40 * GiB)).toBe("low");
    expect(storageSpaceHealth(8 * GiB - 1, 40 * GiB)).toBe("low");
    expect(storageSpaceHealth(2 * GiB, 20 * GiB)).toBe("low");
  });

  it("keeps the absolute 2 GiB warning reserve on smaller volumes", () => {
    expect(storageSpaceHealth(2 * GiB, 5 * GiB)).toBeNull();
    expect(storageSpaceHealth(2 * GiB - 1, 5 * GiB)).toBe("low");
    expect(storageSpaceHealth(GiB, 2 * GiB)).toBe("low");
  });

  it("prioritizes the unchanged critical reserves below 256 MiB or 2 percent", () => {
    expect(storageSpaceHealth(128 * MiB, GiB)).toBe("critical");
    expect(storageSpaceHealth(GiB, 100 * GiB)).toBe("critical");
    expect(storageSpaceHealth(GiB, 50 * GiB)).toBe("low");
    expect(storageSpaceHealth(GiB - 1, 50 * GiB)).toBe("critical");
    expect(storageSpaceHealth(256 * MiB, GiB)).toBe("low");
    expect(storageSpaceHealth(256 * MiB - 1, GiB)).toBe("critical");
    expect(storageSpaceHealth(2 * GiB, 0)).toBe("critical");
  });
});
