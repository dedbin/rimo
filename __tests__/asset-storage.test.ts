// @vitest-environment node

import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, open, readFile, readdir, rm } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { storeAsset, syncStoredAsset } from "../server/asset-storage";

let directory: string;

beforeEach(async () => {
  await mkdir(path.resolve("temp"), { recursive: true });
  directory = await mkdtemp(path.resolve("temp/asset-flush-"));
  vi.stubEnv("ASSET_STORAGE_PATH", directory);
  vi.stubEnv("DATABASE_URL", "postgresql://unused@example.test/rimo");
  vi.stubEnv("BETTER_AUTH_SECRET", randomBytes(32).toString("base64url"));
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  const root = path.resolve("temp");
  if (path.dirname(directory) !== root || !path.basename(directory).startsWith("asset-flush-")) {
    throw new Error("Unexpected asset fixture directory");
  }
  await rm(directory, { recursive: true, force: true });
});

describe("durable asset publication", () => {
  it("writes exact bytes and preserves an existing file when exclusive creation fails", async () => {
    const key = `${randomUUID()}.webp`;
    const bytes = Buffer.from("already normalized image bytes");
    await storeAsset(key, bytes);
    await syncStoredAsset(key);
    await expect(storeAsset(key, Buffer.from("replacement"))).rejects.toMatchObject({ code: "EEXIST" });
    expect(await readFile(path.join(directory, key))).toEqual(bytes);
  });

  it.each(["ENOSPC", "EDQUOT"])("removes only its own file when the final flush fails with %s", async (code) => {
    const existing = `${randomUUID()}.webp`;
    await storeAsset(existing, Buffer.from("existing asset"));
    const probe = await open(path.join(directory, "probe"), "wx");
    const prototype = Object.getPrototypeOf(probe) as Pick<FileHandle, "sync">;
    await probe.close();
    await rm(path.join(directory, "probe"));
    vi.spyOn(prototype, "sync").mockRejectedValueOnce(Object.assign(new Error("injected flush failure"), { code }));

    const failed = `${randomUUID()}.webp`;
    await expect(storeAsset(failed, Buffer.from("new bytes reached the file"))).rejects.toMatchObject({
      status: 507, code: "STORAGE_FULL",
    });
    expect(await readdir(directory)).toEqual([existing]);
    expect(await readFile(path.join(directory, existing))).toEqual(Buffer.from("existing asset"));
  });
});
