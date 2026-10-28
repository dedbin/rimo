// @vitest-environment node
import { randomBytes } from "node:crypto";
import { IncomingMessage, request, ServerResponse } from "node:http";
import type { ClientRequest } from "node:http";
import type { AddressInfo } from "node:net";
import type { Socket } from "node:net";
import { Duplex } from "node:stream";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { MAX_PDF_JOB_BYTES } from "../export-worker/contract";
import { createPdfWorker } from "../export-worker/http";
import { renderPdfHtml } from "../export-worker/render";
import { localPdfResources } from "../export-worker/resources";
import { parsePdfJob } from "../export-worker/validation";
import { pdfFixture } from "./pdf-fixtures";

describe("queued worker preview HTML", () => {
  const token = randomBytes(32).toString("base64url");
  const server = createPdfWorker(token);
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  let origin: string;

  beforeAll(async () => {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const post = (suffix: string, body: unknown = pdfFixture()): Promise<Response> => fetch(`${origin}${suffix}`, {
    method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(5_000),
  });
  const status = async (): Promise<unknown> => (await fetch(`${origin}/healthz`)).json();
  function hold(suffix = "/preview?page=0", declaredLength?: number): { connection: ClientRequest; response: Promise<number> } {
    let connection!: ClientRequest;
    const response = new Promise<number>((resolve) => {
      connection = request(`${origin}${suffix}`, { method: "POST", headers: { ...headers,
        ...(declaredLength === undefined ? {} : { "Content-Length": declaredLength }) } }, (reply) => { reply.resume(); resolve(reply.statusCode ?? 0); });
      connection.on("error", () => resolve(0));
      connection.write("{");
    });
    return { connection, response };
  }

  it("returns exactly the existing page renderer output with local resources and searchable Russian text", async () => {
    const source = pdfFixture();
    const response = await post("/preview?page=1", source);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
    const bytes = Buffer.from(await response.arrayBuffer());
    expect(Number(response.headers.get("content-length"))).toBe(bytes.length);
    const html = bytes.toString("utf8");
    expect(html).toBe(renderPdfHtml(parsePdfJob(source), await localPdfResources(), 1));
    expect(html).toContain("Квадратное уравнение");
    expect(html).toContain('class="katex"');
    expect(html).toContain("data:font/woff2;base64,");
    expect(html.match(/<section /g)).toHaveLength(1);
    expect(html).toContain('data-page="1"');
    expect(html).not.toContain('data-page="0"');
    expect(html).not.toContain("<canvas");
  });

  it("requires an internal credential and a canonical page, and revalidates the complete snapshot", async () => {
    expect((await fetch(`${origin}/preview?page=0`, { method: "POST", body: "{}" })).status).toBe(401);
    expect((await post("/preview?page=20")).status).toBe(400);
    for (const query of ["", "?page=-1", "?page=1.0", "?page=1e0", "?page=00", "?page=0&page=1", "?page=0&extra=1"]) {
      expect((await post(`/preview${query}`)).status).toBe(404);
    }
    const source = pdfFixture();
    const injected = { ...source, layers: [{ ...source.layers[0], richText: { type: "doc", content: [{ type: "html", text: "<script>" }] } }] };
    expect((await post("/preview?page=0", injected)).status).toBe(400);
    const oversized = hold("/preview?page=0", MAX_PDF_JOB_BYTES + 1);
    try { expect(await oversized.response).toBe(413); } finally { oversized.connection.destroy(); }
    await expect.poll(status).toEqual({ ok: true, running: false, waiting: 0 });
  });

  it("shares one active plus two waiting slots with inspect, rejects overflow, and releases aborted slots", async () => {
    const active = hold("/inspect");
    const queued: ReturnType<typeof hold>[] = [];
    try {
      await expect.poll(status).toEqual({ ok: true, running: true, waiting: 0 });
      queued.push(hold());
      await expect.poll(status).toEqual({ ok: true, running: true, waiting: 1 });
      queued.push(hold());
      await expect.poll(status).toEqual({ ok: true, running: true, waiting: 2 });
      const overflow = await post("/preview?page=0");
      expect(overflow.status).toBe(429);
      expect(await overflow.json()).toMatchObject({ error: { code: "PDF_BUSY" } });
      queued[0].connection.destroy();
      await expect.poll(status).toEqual({ ok: true, running: true, waiting: 1 });
      const delivery = post("/preview?page=0");
      await expect.poll(status).toEqual({ ok: true, running: true, waiting: 2 });
      queued[1].connection.destroy();
      active.connection.destroy();
      const delivered = await delivery;
      expect(delivered.status).toBe(200);
      expect(await delivered.text()).toContain("Квадратное уравнение");
      await expect.poll(status).toEqual({ ok: true, running: false, waiting: 0 });
    } finally {
      active.connection.destroy();
      for (const item of queued) item.connection.destroy();
    }
  });

  it.each(["close", "error"] as const)("releases the slot after response body %s following end under backpressure", async (event) => {
    const socket = new Duplex({ read: () => undefined, write: () => undefined });
    socket.on("error", () => undefined);
    const incoming = new IncomingMessage(socket as Socket);
    incoming.method = "POST";
    incoming.url = "/preview?page=0";
    incoming.headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
    incoming.complete = true;
    incoming.push(Buffer.from(JSON.stringify(pdfFixture())));
    incoming.push(null);
    const response = new ServerResponse(incoming);
    response.assignSocket(socket as Socket);
    try {
      server.emit("request", incoming, response);
      await expect.poll(() => response.writableEnded).toBe(true);
      expect(response.writableFinished).toBe(false);
      expect(socket.writableLength).toBeGreaterThan(0);
      const delivery = post("/preview?page=0");
      void delivery.catch(() => undefined);
      await expect.poll(status).toEqual({ ok: true, running: true, waiting: 1 });
      if (event === "close") socket.destroy();
      else response.emit("error", new Error("Fixture response delivery failed"));
      await expect.poll(status, { timeout: 1_000 }).toEqual({ ok: true, running: false, waiting: 0 });
      expect(socket.destroyed).toBe(true);
      const delivered = await delivery;
      expect(delivered.status).toBe(200);
      expect(await delivered.text()).toContain("Квадратное уравнение");
    } finally { socket.destroy(); }
  });
});
