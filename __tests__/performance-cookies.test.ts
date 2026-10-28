// @vitest-environment node

import { request } from "playwright";
import { describe, expect, it } from "vitest";

import { CookieScopeError, cookieHeaderForUrl, websocketCookieHeader } from "../scripts/performance/cookies.mjs";

function cookie(name: string, properties: Record<string, unknown> = {}) {
  return { name, value: "synthetic-fixture", domain: "board.example.test", path: "/", expires: -1,
    httpOnly: true, secure: false, sameSite: "Lax" as const, ...properties };
}
function names(header: string): string[] { return header ? header.split("; ").map((entry) => entry.slice(0, entry.indexOf("="))) : []; }

describe("performance WebSocket cookie scope", () => {
  it("scopes a real Playwright storage state by host-only, Domain, path boundary, expiry and Secure", async () => {
    const context = await request.newContext({ storageState: { origins: [], cookies: [
      cookie("root"), cookie("exact", { path: "/collab/room" }), cookie("parent_path", { path: "/collab" }),
      cookie("different_path", { path: "/api/auth" }), cookie("path_boundary", { path: "/collaboration" }),
      cookie("parent_host_only", { domain: "example.test" }), cookie("parent_domain", { domain: ".example.test" }),
      cookie("different_domain", { domain: "other.example.test" }),
      cookie("expired", { expires: Math.floor(Date.now() / 1_000) - 60 }),
      cookie("future", { expires: Math.floor(Date.now() / 1_000) + 3_600 }),
      cookie("tls_only", { secure: true }), cookie("partitioned", { partitionKey: "https://board.example.test" }),
    ] } });
    try {
      const header = await websocketCookieHeader(context, "http://board.example.test", "ws://board.example.test:1234/collab/room?unit=query");
      expect(names(header)).toEqual(["exact", "parent_path", "root", "parent_domain", "future"]);
    } finally { await context.dispose(); }
  });

  it("rejects path-prefix siblings and host-only parent cookies without relying on SDK filtering", async () => {
    const state = [cookie("wrong_boundary", { path: "/collab" }), cookie("wrong_host", { domain: "example.test" }),
      cookie("domain_match", { domain: ".example.test" })];
    expect(names(await cookieHeaderForUrl(state, "http://board.example.test/collaboration"))).toEqual(["domain_match"]);
    expect(names(await cookieHeaderForUrl(state, "http://board.example.test/collab"))).toEqual(["wrong_boundary", "domain_match"]);
  });

  it("uses HTTPS for WSS, keeps HttpOnly and sends Secure only over TLS, including localhost", async () => {
    const state = [cookie("plain"), cookie("secure", { secure: true }),
      cookie("__Secure-unit", { secure: true }), cookie("__Host-unit", { secure: true })];
    const context = { async storageState() { return { cookies: state }; } };
    expect(names(await websocketCookieHeader(context, "https://board.example.test:8443", "wss://board.example.test:9443/")))
      .toEqual(["plain", "secure", "__Secure-unit", "__Host-unit"]);
    expect(names(await websocketCookieHeader(context, "http://board.example.test", "ws://board.example.test/"))).toEqual(["plain"]);
    expect(names(await cookieHeaderForUrl([cookie("local_secure", { domain: "localhost", secure: true })], "http://localhost/")))
      .toEqual([]);
  });

  it("preserves path ordering for duplicate names and omits expired or partitioned state", async () => {
    const state = [cookie("duplicate"), cookie("duplicate", { path: "/collab", value: "synthetic-path-fixture" }),
      cookie("expired", { expires: 1 }), cookie("partitioned", { partitionKey: "https://board.example.test" })];
    expect(await cookieHeaderForUrl(state, "https://board.example.test/collab/room"))
      .toBe("duplicate=synthetic-path-fixture; duplicate=synthetic-fixture");
  });

  it.each([
    ["https://board.example.test", "ws://board.example.test/"],
    ["http://board.example.test", "wss://board.example.test/"],
    ["https://board.example.test", "wss://other.example.test/"],
    ["http://board.example.test", "ws://user:synthetic@board.example.test/"],
  ])("rejects mismatched host/scheme or URL credentials before reading cookies", async (application, websocket) => {
    let stateRead = false;
    const context = { async storageState() { stateRead = true; return { cookies: [] }; } };
    await expect(websocketCookieHeader(context, application, websocket)).rejects.toBeInstanceOf(CookieScopeError);
    expect(stateRead).toBe(false);
  });

  it("fails closed with a controlled message for malformed cookie state", async () => {
    await expect(cookieHeaderForUrl([cookie("bad\r\nname")], "https://board.example.test/"))
      .rejects.toThrow("Cookie storage state cannot be scoped safely");
  });
});
