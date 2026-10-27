import { describe, expect, it } from "vitest";
import { storageSpaceHealth } from "../server/operations/status";

const MiB = 1024 * 1024;
const GiB = 1024 * MiB;
describe("operator disk reserve thresholds", () => {
  it("warns below 2 GiB or 10 percent and becomes critical below 256 MiB or 2 percent", () => {
    expect(storageSpaceHealth(3 * GiB, 10 * GiB)).toBeNull();
    expect(storageSpaceHealth(2 * GiB, 20 * GiB)).toBeNull();
    expect(storageSpaceHealth(GiB, 2 * GiB)).toBe("low");
    expect(storageSpaceHealth(3 * GiB, 40 * GiB)).toBe("low");
    expect(storageSpaceHealth(128 * MiB, GiB)).toBe("critical");
    expect(storageSpaceHealth(GiB, 100 * GiB)).toBe("critical");
    expect(storageSpaceHealth(256 * MiB, GiB)).toBe("low");
    expect(storageSpaceHealth(2 * GiB, 0)).toBe("critical");
  });
});
