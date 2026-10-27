// @vitest-environment node
import { describe, expect, it, vi } from "vitest";

const child = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn: child.spawn }));

import { integrationTestEnvironment } from "../scripts/test-integration.mjs";

describe("explicit integration database selection", () => {
  it("does not launch Vitest or connect to PostgreSQL when imported", () => {
    expect(child.spawn).not.toHaveBeenCalled();
  });

  it.each([undefined, "", " ", "\t"])("rejects an absent or blank dedicated DSN (%s) despite DATABASE_URL", (testUrl) => {
    const environment = Object.freeze({ NODE_ENV: "test", DATABASE_URL: "postgresql://foreign.invalid/private-marker-database",
      RIMO_TEST_DATABASE_URL: testUrl, OTHER_SECRET: "private-marker" });
    expect(() => integrationTestEnvironment(environment))
      .toThrow("Set RIMO_TEST_DATABASE_URL to a dedicated PostgreSQL test database");
    try { integrationTestEnvironment(environment); }
    catch (error) {
      expect(String(error)).not.toContain("foreign");
      expect(String(error)).not.toContain("private-marker");
    }
    expect(child.spawn).not.toHaveBeenCalled();
  });

  it("overrides a different application DSN with the explicit test DSN without changing its input", () => {
    const environment = Object.freeze({ NODE_ENV: "test", DATABASE_URL: "postgresql://foreign.invalid/application",
      RIMO_TEST_DATABASE_URL: "postgresql://fixture.invalid/dedicated_test", PRESERVED_SETTING: "fixture" });
    const result = integrationTestEnvironment(environment);
    expect(result).toEqual({ NODE_ENV: "test", DATABASE_URL: environment.RIMO_TEST_DATABASE_URL,
      RIMO_TEST_DATABASE_URL: environment.RIMO_TEST_DATABASE_URL, PRESERVED_SETTING: "fixture" });
    expect(result).not.toBe(environment);
    expect(environment.DATABASE_URL).toBe("postgresql://foreign.invalid/application");
    expect(child.spawn).not.toHaveBeenCalled();
  });
});
