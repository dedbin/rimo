// @vitest-environment node

import { randomBytes } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getServerConfig } from "../server/config";

beforeEach(() => {
  vi.stubEnv("DATABASE_URL", "postgresql://localhost/config-test");
  vi.stubEnv("BETTER_AUTH_SECRET", randomBytes(32).toString("base64url"));
  vi.stubEnv("BETTER_AUTH_URL", "https://board.example.test");
  vi.stubEnv("COLLABORATION_PUBLIC_URL", undefined);
  vi.stubEnv("NEXT_PUBLIC_COLLABORATION_URL", undefined);
});
afterEach(() => { vi.unstubAllEnvs(); });

describe("runtime collaboration endpoint configuration", () => {
  it("uses the current server-only value and permits the same build in different environments", () => {
    vi.stubEnv("NEXT_PUBLIC_COLLABORATION_URL", "ws://localhost:19999");
    vi.stubEnv("COLLABORATION_PUBLIC_URL", "wss://first.example.test/collaboration");
    expect(getServerConfig().collaborationUrl).toBe("wss://first.example.test/collaboration");
    vi.stubEnv("COLLABORATION_PUBLIC_URL", "wss://second.example.test/collaboration");
    expect(getServerConfig().collaborationUrl).toBe("wss://second.example.test/collaboration");
  });

  it("keeps the legacy key and derives a default when neither is provided", () => {
    expect(getServerConfig().collaborationUrl).toBe("wss://board.example.test/collaboration");
    vi.stubEnv("NEXT_PUBLIC_COLLABORATION_URL", "ws://localhost:1234/");
    expect(getServerConfig().collaborationUrl).toBe("ws://localhost:1234/");
  });

  it("rejects a protocol or embedded credentials that cannot be sent to board participants", () => {
    vi.stubEnv("COLLABORATION_PUBLIC_URL", "https://board.example.test/collaboration");
    expect(() => getServerConfig()).toThrow("must be a WebSocket URL");
    const value = new URL("wss://board.example.test/collaboration");
    value.username = "example";
    value.password = randomBytes(12).toString("base64url");
    vi.stubEnv("COLLABORATION_PUBLIC_URL", value.href);
    expect(() => getServerConfig()).toThrow("must not contain credentials");
  });
});
