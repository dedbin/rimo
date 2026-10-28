// @vitest-environment node
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { spoolArchive } from "../server/archive/workspace";

describe("archive upload deadline", () => {
  it("cancels a stalled body stream instead of holding the archive slot forever", async () => {
    const root = path.resolve("temp");
    const directory = await mkdtemp(path.join(root, "archive-deadline-"));
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } });
    const init: RequestInit & { duplex: "half" } = { method: "POST", body, duplex: "half" };
    try {
      await expect(spoolArchive(new Request("http://localhost:3000/api/boards/import", init), path.join(directory, "incoming.zip"), new AbortController().signal, 20))
        .rejects.toMatchObject({ status: 408, code: "ARCHIVE_UPLOAD_TIMEOUT" });
      expect(cancelled).toBe(true);
    } finally {
      if (path.dirname(directory) !== root) throw new Error("Unexpected test cleanup directory");
      await rm(directory, { recursive: true, force: true });
    }
  });
});
