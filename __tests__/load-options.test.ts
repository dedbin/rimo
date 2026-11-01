// @vitest-environment node
import { describe, expect, it } from "vitest";

import { loadOptions } from "../scripts/performance/load-options.mjs";

const baseline = { seconds: "3600", rooms: "20", connections: "40", editors: "40", objects: "3000",
  "edit-hz": "2", "presence-hz": "10", "batch-size": "500", "batch-every-seconds": "30", "sample-seconds": "10" };

describe("open-registration load profile", () => {
  it("accepts 20 paired rooms without reducing the requested editing cadence", () => {
    expect(loadOptions(baseline)).toMatchObject({ seconds: 3600, rooms: 20, connections: 40, editors: 40,
      editHz: 2, presenceHz: 10, batchSize: 500 });
  });

  it.each([{ rooms: "21" }, { editors: "51", connections: "51" }, { rooms: "20", editors: "19" },
    { editors: "41", connections: "40" }, { rooms: "1", connections: "11", editors: "2" }])(
    "rejects an inconsistent or unbounded load before accessing a service: %o", (patch) => {
      expect(() => loadOptions({ ...baseline, ...patch })).toThrow();
    });
});
