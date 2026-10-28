// @vitest-environment node
import { execFile, type spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { PassThrough } from "node:stream";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createDockerRunner } from "../scripts/tls-acceptance/run.mjs";

const execute = promisify(execFile);
const script = path.resolve("scripts/tls-acceptance/run.mjs");
const scriptUrl = pathToFileURL(script).href;
const root = path.resolve("temp/tls-acceptance/unit");

function runnerFixture() {
  vi.useFakeTimers();
  const controller = new AbortController();
  const phase = vi.fn();
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
    kill: vi.fn(() => true), unref: vi.fn(),
  });
  const remove = vi.spyOn(controller.signal, "removeEventListener");
  const spawnProcess = vi.fn(() => child) as unknown as typeof spawn;
  const runner = createDockerRunner({}, controller.signal, phase, "fake-docker", { spawnProcess });
  return { controller, child, phase, remove, runner };
}

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe("TLS Docker runner private stream failures", () => {
  it.each(["stdout", "stderr", "stdin"] as const)("rejects %s errors before a late successful exit and reaches finally", async stream => {
    const { controller, child, phase, remove, runner } = runnerFixture();
    const privateText = "private-stream-error-sentinel";
    let finalized = false;
    const outcome = runner(["ignored"], { input: Buffer.from(privateText), relay: true, timeout: 5_000 })
      .catch(error => error as Error).finally(() => { finalized = true; });
    child.stdout.write(`TLS_PHASE active\n${privateText}\n`);
    child.stderr.write(privateText);
    expect(() => child[stream].emit("error", new Error(privateText))).not.toThrow();
    controller.abort(new Error("later-private-abort"));
    child.stdout.write("TLS_PHASE after-error\n");
    child.emit("close", 0);
    const result = await outcome;
    expect(result).toBeInstanceOf(Error);
    expect((result as Error).message).toBe(`TLS_DOCKER_${stream.toUpperCase()}_STREAM`);
    expect(String(result)).not.toContain(privateText);
    expect(finalized).toBe(true);
    expect(child.kill).toHaveBeenCalledExactlyOnceWith("SIGKILL");
    expect(phase.mock.calls).toEqual([["active"]]);
    expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
    expect(vi.getTimerCount()).toBe(0);
    expect(() => {
      child[stream].emit("error", new Error("late-private-stream"));
      child.emit("error", new Error("late-private-process"));
      child.emit("close", 0);
    }).not.toThrow();
  });

  it("settles safely when kill throws and the child never emits close", async () => {
    const { child, remove, runner } = runnerFixture();
    child.kill.mockImplementation(() => { throw new Error("private-kill-failure"); });
    let finalized = false;
    const outcome = runner(["ignored"], { timeout: 5_000 }).catch(error => error as Error)
      .finally(() => { finalized = true; });
    child.stdout.emit("error", new Error("private-output-failure"));
    await vi.advanceTimersByTimeAsync(1_000);
    expect((await outcome as Error).message).toBe("TLS_DOCKER_STDOUT_STREAM");
    expect(finalized).toBe(true);
    expect(child.kill).toHaveBeenCalledExactlyOnceWith("SIGKILL");
    expect(child.unref).toHaveBeenCalledOnce();
    expect([child.stdin.destroyed, child.stdout.destroyed, child.stderr.destroyed]).toEqual([true, true, true]);
    expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps a deadline as the first failure after a later stream error", async () => {
    const { child, runner } = runnerFixture();
    const outcome = runner(["ignored"], { timeout: 5 }).catch(error => error as Error);
    await vi.advanceTimersByTimeAsync(5);
    child.stderr.emit("error", new Error("later-private-stream"));
    child.emit("close", 7);
    expect((await outcome as Error).message).toBe("TLS_COMMAND_DEADLINE");
    expect(child.kill).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rejects a synchronous stdin write failure instead of accepting exit zero", async () => {
    const { child, runner } = runnerFixture();
    vi.spyOn(child.stdin, "end").mockImplementationOnce(() => { throw new Error("private-input-failure"); });
    const outcome = runner(["ignored"], { input: Buffer.from("private-input") }).catch(error => error as Error);
    child.emit("close", 0);
    expect((await outcome as Error).message).toBe("TLS_DOCKER_STDIN_STREAM");
    expect(child.kill).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("replaces a synchronous spawn error with a safe failure", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const add = vi.spyOn(controller.signal, "addEventListener");
    const spawnProcess = vi.fn(() => { throw new Error("private-spawn-failure"); }) as unknown as typeof spawn;
    const runner = createDockerRunner({}, controller.signal, vi.fn(), "fake-docker", { spawnProcess });
    await expect(runner(["ignored"])).rejects.toThrow(/^TLS_DOCKER_SPAWN$/);
    expect(add).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("TLS acceptance opt-in and interruption boundary without Docker/browser", () => {
  it("shows help from another working directory without starting a service", async () => {
    const result = await execute(process.execPath, [script, "--help"], { cwd: path.dirname(script), timeout: 5_000, windowsHide: true });
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("RIMO_TEST_DOCKER_TLS=1");
    expect(result.stdout).toContain("--app-image rimo:local");
  });

  it("requires explicit opt-in before resolving Docker images", async () => {
    const result = await execute(process.execPath, [script], { env: { ...process.env, RIMO_TEST_DOCKER_TLS: "", PATH: "" }, timeout: 5_000, windowsHide: true })
      .then(() => null, (error: { code: number; stdout: string; stderr: string }) => error);
    expect(result?.code).toBe(1);
    expect(result?.stdout).toBe("");
    expect(JSON.parse(result!.stderr)).toEqual({ status: "failed", errorCode: "TLS_OPT_IN_REQUIRED" });
  });

  it.each(["SIGINT", "SIGTERM", "deadline"])("kills its active child and reaches cleanup on %s", async (reason) => {
    await mkdir(root, { recursive: true });
    const pidFile = path.join(root, `${randomUUID()}.pid`);
    const childSource = String.raw`require('node:fs').writeFileSync(process.argv[1],String(process.pid),{flag:'wx'});process.stdout.write('TLS_PHASE active\nTLS_PHASE buffered\n');setInterval(()=>{},1000)`;
    const source = `
      import { readFile, rm } from 'node:fs/promises';
      import { createTlsLifecycle, createDockerRunner } from ${JSON.stringify(scriptUrl)};
      const [pidFile, reason] = process.argv.slice(1);
      const report = {status:'passed',cleanup:'pending'};
      const lifecycle = createTlsLifecycle(report,reason==='deadline'?1000:5000);
      const phases=[];
      const runner=createDockerRunner(process.env,lifecycle.signal,name=>{
        phases.push(name);
        if(name==='active'&&reason!=='deadline')process.emit(reason);
      },process.execPath);
      let childAlive=true;
      try{
        const child=${JSON.stringify(childSource)};
        await runner(['-e',child,pidFile],{relay:true,timeout:4000});
      }catch{ /* Cancellation must reject into the same finally boundary. */ }
      finally{
        const pid=Number(await readFile(pidFile,'utf8'));
        try{process.kill(pid,0);}catch(error){if(error.code==='ESRCH')childAlive=false;else throw error;}
        await rm(pidFile);
        report.cleanup=childAlive?'failed':'complete';
        await lifecycle.finalize(async()=>{});
        process.stdout.write(JSON.stringify({report,childAlive,phases})+'\\n');
        process.exitCode=lifecycle.exitCode();
        lifecycle.dispose();
      }
    `;
    try {
      const result = await execute(process.execPath, ["--input-type=module", "--eval", source, pidFile, reason], { timeout: 7_000, windowsHide: true })
        .then(() => null, (error: { code: number; stdout: string; stderr: string }) => error);
      expect(result?.stderr).toBe("");
      expect(result?.code).toBe(reason === "SIGINT" ? 130 : reason === "SIGTERM" ? 143 : 124);
      const summary = JSON.parse(result!.stdout);
      expect(summary).toMatchObject({ childAlive: false, report: { status: "interrupted", cleanup: "complete", interruption: { reason } } });
      expect(summary.phases).toEqual(reason === "deadline" ? ["active", "buffered"] : ["active"]);
    } finally {
      if (path.dirname(path.resolve(pidFile)) !== root) throw new Error("Unsafe TLS unit cleanup path");
      await rm(pidFile, { force: true });
    }
  }, 10_000);

  it.each(["SIGINT", "SIGTERM"])("rewrites an initially passed report after late %s", async (reason) => {
    await mkdir(root, { recursive: true });
    const output = path.join(root, `${randomUUID()}.json`);
    const source = `
      import { writeFile } from 'node:fs/promises';
      import { createTlsLifecycle } from ${JSON.stringify(scriptUrl)};
      const [output,reason]=process.argv.slice(1);
      const report={status:'passed',cleanup:'complete'};
      const lifecycle=createTlsLifecycle(report,5000);
      let snapshots=0;
      Object.defineProperty(report,'toJSON',{value(){
        const snapshot={...report};
        if(++snapshots===1)queueMicrotask(()=>process.emit(reason));
        return snapshot;
      }});
      try{
        await lifecycle.finalize(()=>writeFile(output,JSON.stringify(report)));
        process.stdout.write(JSON.stringify({snapshots})+'\\n');
        process.exitCode=lifecycle.exitCode();
      }finally{lifecycle.dispose();}
    `;
    try {
      const result = await execute(process.execPath, ["--input-type=module", "--eval", source, output, reason], { timeout: 7_000, windowsHide: true })
        .then(() => null, (error: { code: number; stdout: string; stderr: string }) => error);
      expect(result?.code).toBe(reason === "SIGINT" ? 130 : 143);
      expect(result?.stderr).toBe("");
      expect(JSON.parse(result!.stdout)).toEqual({ snapshots: 2 });
      expect(JSON.parse(await readFile(output, "utf8"))).toMatchObject({ status: "interrupted", cleanup: "complete", interruption: { reason } });
    } finally {
      if (path.dirname(path.resolve(output)) !== root) throw new Error("Unsafe TLS unit report cleanup path");
      await rm(output, { force: true });
    }
  }, 10_000);
});
