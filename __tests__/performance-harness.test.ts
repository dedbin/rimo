// @vitest-environment node

import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

const execute = promisify(execFile);

describe("performance harness safety and deterministic scene", () => {
  it("validates the 3000-object scene and selects exactly500 with one Yjs runtime and no service/browser", async () => {
    const result = await execute(process.execPath, ["--import=tsx", "scripts/measure-editor.mjs", "--self-test"], { timeout: 15_000, windowsHide: true });
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toMatchObject({ objects: 3_000, visible: 500, errorCallLogRedacted: true });
  }, 20_000);

  it("rejects an hour-long run before reading credentials or contacting a service without explicit opt-in", async () => {
    await expect(execute(process.execPath, ["--import=tsx", "scripts/load-collaboration.mjs", "--seconds", "3600",
      "--storage-state", "does-not-exist"], { env: { ...process.env, RIMO_RUN_LONG_LOAD: "" }, timeout: 15_000, windowsHide: true }))
      .rejects.toMatchObject({ stderr: expect.stringContaining("explicit RIMO_RUN_LONG_LOAD=1") });
  }, 20_000);

  it("measures real writer/viewer delivery, batch commits, ping/pong and final acknowledgements in a short isolated server", async () => {
    const result = await execute(process.execPath, ["--import=tsx", "scripts/performance/self-load.mjs"], { timeout: 15_000, windowsHide: true });
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toMatchObject({ kind: "load-harness-check", pending: 0, readonly: true, persisted: true });
  }, 20_000);

  it.each(["SIGINT", "SIGTERM"])("returns nonzero after graceful %s despite successful persistence and cadence", async (signal) => {
    const result = await execute(process.execPath, ["--import=tsx", "scripts/performance/self-load.mjs", signal],
      { timeout: 15_000, windowsHide: true }).then(() => null, (error: { code: number; stdout: string; stderr: string }) => error);
    expect(result?.code).toBe(1);
    expect(result?.stderr).toBe("");
    const summary = JSON.parse(result!.stdout.trim().split(/\r?\n/).at(-1)!);
    expect(summary).toMatchObject({ kind: "load-interruption-check", signal, interrupted: true,
      persisted: true, pending: 0, cadenceAtLeast95Percent: true, requestedSeconds: 30 });
    expect(summary.steadySeconds).toBeLessThan(5);
  }, 20_000);

  it.each([
    ["cleanup", "SIGINT", "complete"],
    ["report", "SIGINT", "complete"],
    ["report", "SIGTERM", "complete"],
    ["report", "SIGHUP", "complete"],
    ["report", "SIGINT", "cleanup-failed"],
  ])("handles late %s-phase %s without success from initial status %s", async (phase, signal, status) => {
    const filename = path.resolve(`temp/performance/report-interruption-${randomUUID()}.json`);
    // Queue the signal after JSON captures its first snapshot, during the real fs write.
    const source = `
      import { installLoadInterruptHandlers, writeFinalReport } from "./scripts/performance/common.mjs";
      const [filename, phase, signal, status] = process.argv.slice(1);
      const controller = new AbortController();
      const removeHandlers = installLoadInterruptHandlers(controller);
      const report = { status, cleanup: [] };
      let snapshots = 0;
      Object.defineProperty(report, "toJSON", { value() {
        const snapshot = { ...report };
        if (++snapshots === 1 && phase === "report") queueMicrotask(() => process.emit(signal));
        return snapshot;
      } });
      try {
        if (phase === "cleanup") await new Promise((resolve) => setImmediate(() => { process.emit(signal); resolve(); }));
        await writeFinalReport(filename, report, controller.signal);
      } finally { removeHandlers(); }
      process.stdout.write(JSON.stringify({ snapshots, exitCode: process.exitCode }) + "\\n");
    `;
    try {
      const result = await execute(process.execPath, ["--import=tsx", "--input-type=module", "--eval", source, filename, phase, signal, status],
        { timeout: 15_000, windowsHide: true }).then(() => null, (error: { code: number; stdout: string; stderr: string }) => error);
      expect(result?.code).toBe(1);
      expect(result?.stderr).toBe("");
      const summary = JSON.parse(result!.stdout.trim().split(/\r?\n/).at(-1)!);
      expect(summary).toMatchObject({ snapshots: phase === "report" ? 2 : 1, exitCode: 1 });
      expect(JSON.parse(await readFile(filename, "utf8"))).toMatchObject({
        status: status === "cleanup-failed" ? "cleanup-failed" : "interrupted", interrupted: true, cleanup: [],
      });
    } finally { await rm(filename, { force: true }); }
  }, 20_000);
});
