// @vitest-environment node
import { describe, expect, it, vi } from "vitest";

import { RuntimeMetrics } from "../collaboration-server/runtime-metrics";
import { createCollaborationServer } from "../collaboration-server/server";
import type { CollaborationDependencies } from "../collaboration-server/types";

describe("existing private health endpoint runtime observations", () => {
  it("keeps health status, reports only process counters, and stops the observers", async () => {
    let healthy = true;
    const start = vi.spyOn(RuntimeMetrics.prototype, "start");
    const stop = vi.spyOn(RuntimeMetrics.prototype, "stop");
    const dependencies: CollaborationDependencies = {
      authenticate: async () => null, revalidate: async () => null,
      repository: { load: async () => null, save: async () => ({ revision: 1, savedAt: new Date() }), health: async () => healthy },
    };
    const server = createCollaborationServer({ origins: ["http://localhost"], port: 0 }, dependencies);
    try {
      await server.listen();
      const origin = `http://127.0.0.1:${server.address.port}`;
      const response = await fetch(`${origin}/healthz`);
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.status).toBe("ok");
      expect(body.runtime).toMatchObject({ version: 1 });
      for (const key of ["rssBytes", "heapUsedBytes", "heapTotalBytes", "heapLimitBytes"]) {
        expect(body.runtime[key]).toBeGreaterThan(0);
      }
      expect(Object.values(body.runtime).every((value) => value === null || typeof value === "number" && Number.isFinite(value))).toBe(true);
      expect(Object.keys(body)).toEqual(["status", "runtime"]);
      healthy = false;
      const unavailable = await fetch(`${origin}/health`);
      expect(unavailable.status).toBe(503);
      expect(await unavailable.json()).toMatchObject({ status: "unavailable", runtime: { version: 1 } });
      expect((await fetch(`${origin}/diagnostics`)).status).toBe(404);
    } finally {
      await server.destroy();
      expect(start).toHaveBeenCalledTimes(1);
      expect(stop).toHaveBeenCalledTimes(1);
      start.mockRestore(); stop.mockRestore();
    }
  });
});
