// @vitest-environment node

import { describe, expect, it } from "vitest";

import { readRequestBuffer } from "../server/http";

describe("HTTP request body limits", () => {
  it("cancels a stalled stream after the total read deadline", async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new Uint8Array([1])); },
      cancel() { cancelled = true; },
    });
    const options: RequestInit & { duplex: "half" } = { method: "POST", body, duplex: "half" };
    const request = new Request("http://localhost/request", options);
    await expect(readRequestBuffer(request, 100, 20)).rejects.toMatchObject({ status: 408, code: "BODY_TIMEOUT" });
    expect(cancelled).toBe(true);
  });

  it("stops an oversized chunked body before reading all of it", async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new Uint8Array(101)); },
      cancel() { cancelled = true; },
    });
    const options: RequestInit & { duplex: "half" } = { method: "POST", body, duplex: "half" };
    const request = new Request("http://localhost/request", options);
    await expect(readRequestBuffer(request, 100)).rejects.toMatchObject({ status: 413 });
    expect(cancelled).toBe(true);
  });
});
