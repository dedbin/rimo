// @vitest-environment node
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { fileIntegrity, processToFile, readBackupManifest, runningWriters } from "../scripts/backup-common.mjs";

describe("backup binary files", () => {
  it("preserves arbitrary stdout bytes without shell text conversion", async () => {
    const root = path.resolve("temp");
    await mkdir(root, { recursive: true });
    const directory = await mkdtemp(path.join(root, "backup-stream-"));
    try {
      const filename = path.join(directory, "binary.dump");
      await processToFile(process.execPath, ["-e", "process.stdout.write(Buffer.from([0,255,128,10,13,26,0]))"], process.env, filename);
      expect(await readFile(filename)).toEqual(Buffer.from([0, 255, 128, 10, 13, 26, 0]));
      await writeFile(path.join(directory, "assets.tar"), "tar fixture");
      const files = { "database.dump": await fileIntegrity(filename), "assets.tar": await fileIntegrity(path.join(directory, "assets.tar")) };
      await writeFile(path.join(directory, "database.dump"), await readFile(filename));
      await writeFile(path.join(directory, "manifest.json"), JSON.stringify({ format: "rimo-service-backup", version: 1, postgresMajor: 18, createdAt: new Date().toISOString(), files }));
      expect((await readBackupManifest(directory)).format).toBe("rimo-service-backup");
      await writeFile(path.join(directory, "assets.tar"), "tampered");
      await expect(readBackupManifest(directory)).rejects.toThrow("integrity check failed");
    } finally {
      if (path.dirname(directory) !== root) throw new Error("Unexpected backup test directory");
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("aborts a running binary stream so backup cleanup can resume writers", async () => {
    const root = path.resolve("temp");
    await mkdir(root, { recursive: true });
    const directory = await mkdtemp(path.join(root, "backup-stream-"));
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 100);
    try {
      await expect(processToFile(process.execPath, ["-e", "setInterval(()=>process.stdout.write(Buffer.alloc(1024)),10)"], process.env, path.join(directory, "partial.dump"), controller.signal)).rejects.toMatchObject({ name: "AbortError" });
    } finally {
      clearTimeout(timer);
      if (path.dirname(directory) !== root) throw new Error("Unexpected backup test directory");
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("pauses restart-loop writers and rejects paused containers before copying", async () => {
    const context = { run: async () => JSON.stringify([
      { Service: "app", State: "restarting" }, { Service: "collaboration", State: "exited" },
    ]) };
    expect(await runningWriters(context)).toEqual(["app"]);
    await expect(runningWriters({ run: async () => JSON.stringify([{ Service: "app", State: "paused" }]) })).rejects.toThrow("resolve paused");
  });
});
