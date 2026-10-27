// @vitest-environment node
import type { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { PassThrough } from "node:stream";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { fileIntegrity } from "../scripts/backup-common.mjs";
import { performRestic } from "../scripts/restic-backup.mjs";
import { MAX_AGE_MS, resticOptions, runRestic, sourceTag, verifyLocalBackup } from "../scripts/restic-common.mjs";

const NOW = Date.parse("2026-10-27T12:00:00Z");
const ID = "a".repeat(64);
const HOST = "restic-test-host";
const TAG = "rimo-service:rimo";
const root = path.resolve("temp");
let directory: string;
let input: string;
let environment: Record<string, string>;

function result(stdout: string, exitCode: number | null = 0, signal: string | null = null) {
  return { stdout, exitCode, signal };
}
function snapshot(changes: Record<string, unknown> = {}) {
  const time = typeof changes.time === "string" ? changes.time : new Date(NOW).toISOString();
  return { id: ID, time, hostname: HOST, tags: [TAG, sourceTag(Date.parse(time))], paths: [input], ...changes };
}
function runner() {
  return vi.fn(async (args: string[], ...context: unknown[]) => {
    void context;
    if (args[0] === "backup") return result(JSON.stringify({ message_type: "summary", snapshot_id: ID }));
    if (args[0] === "snapshots") return result(JSON.stringify([snapshot()]));
    if (args[0] === "check") return result('{"message_type":"summary","num_errors":0}');
    throw new Error("Unexpected restic command");
  });
}
const options = () => ({ input, project: "rimo", checkAge: false });

beforeEach(async () => {
  await mkdir(root, { recursive: true });
  directory = await mkdtemp(path.join(root, "restic-unit-"));
  input = path.join(directory, "completed");
  await mkdir(input);
  input = await realpath(input);
  await writeFile(path.join(input, "database.dump"), Buffer.from([0, 255, 10, 32]));
  await writeFile(path.join(input, "assets.tar"), "archive fixture");
  const files = Object.fromEntries(await Promise.all(["database.dump", "assets.tar"].map(async name =>
    [name, await fileIntegrity(path.join(input, name))])));
  await writeFile(path.join(input, "manifest.json"), JSON.stringify({ format: "rimo-service-backup", version: 1,
    sourceProject: "rimo", postgresMajor: 18, createdAt: new Date(NOW).toISOString(), files }));
  const passwordFile = path.join(directory, "password");
  await writeFile(passwordFile, "unit-test-only", { mode: 0o600 });
  environment = { RESTIC_REPOSITORY: "s3:https://private.invalid/private-repository", RESTIC_PASSWORD_FILE: passwordFile };
});
afterEach(async () => {
  vi.useRealTimers();
  if (path.dirname(directory) !== root || !path.basename(directory).startsWith("restic-unit-")) throw new Error("Unsafe test cleanup");
  await rm(directory, { recursive: true, force: true });
});

describe("restic operator contract", () => {
  it("uses only fixed commands, exact metadata and read-data verification without claiming offsite storage", async () => {
    const run = runner();
    const completed = await performRestic(options(), environment, { run, clock: () => NOW, host: HOST });
    expect(completed).toEqual({ exitCode: 0, report: { complete: true, mode: "backup", snapshotID: ID,
      createdAt: new Date(NOW).toISOString(), sourceCreatedAt: new Date(NOW).toISOString(),
      status: "fresh", ageSeconds: 0, encrypted: true, dataVerified: true, offsiteVerified: false } });
    expect(run.mock.calls.map(([args]) => args)).toEqual([
      ["backup", "--json", "--host", HOST, "--tag", TAG, "--tag", sourceTag(NOW), "--", input],
      ["snapshots", "--json", "--host", HOST, "--tag", TAG, ID], ["check", "--json", "--read-data"],
    ]);
    for (const secret of [input, environment.RESTIC_REPOSITORY, environment.RESTIC_PASSWORD_FILE, HOST]) {
      expect(JSON.stringify(completed.report)).not.toContain(secret);
    }
  });

  it("supports a repository file and removes an inherited host override", async () => {
    const repositoryFile = path.join(directory, "repository");
    await writeFile(repositoryFile, "unit-test-repository");
    const run = runner();
    const env = { RESTIC_REPOSITORY_FILE: repositoryFile, RESTIC_PASSWORD_FILE: environment.RESTIC_PASSWORD_FILE, RESTIC_HOST: "other" };
    expect((await performRestic(options(), env, { run, clock: () => NOW, host: HOST })).exitCode).toBe(0);
    expect(run.mock.calls[0][1]).not.toHaveProperty("RESTIC_HOST");
  });

  it.each([
    [], ["--project", "rimo"], ["--input", "local", "--project", "--invalid"],
    ["--input", "local", "--project", "rimo", "--prune"], ["--check-age", "--project", "rimo", "--input", "local"],
    ["--check-age", "--project", "rimo", "extra"], ["--input", "local", "--project", "rimo", "--check-data"],
  ].map(args => ({ args })))("rejects missing, ambiguous or unsupported CLI options: $args", ({ args }) => {
    expect(() => resticOptions(args)).toThrow("INVALID_OPTIONS");
  });

  it("does not require input for an age check", () => {
    expect(resticOptions(["--check-age", "--project", "rimo"])).toEqual({ project: "rimo", input: undefined, checkAge: true });
  });

  it.each(["RESTIC_PASSWORD", "RESTIC_PASSWORD_COMMAND"])("rejects %s before executing anything", async name => {
    const run = runner();
    expect(await performRestic(options(), { ...environment, [name]: "private-value" }, { run })).toMatchObject({
      exitCode: 2, report: { complete: false, stage: "credentials" },
    });
    expect(run).not.toHaveBeenCalled();
  });

  it.each(["tampered", "additional-file", "wrong-project"])("rejects a local copy with %s before restic", async kind => {
    if (kind === "tampered") await writeFile(path.join(input, "assets.tar"), "modified");
    if (kind === "additional-file") await writeFile(path.join(input, "unexpected-secret"), "private");
    const run = runner();
    const selected = { ...options(), project: kind === "wrong-project" ? "other" : "rimo" };
    expect(await performRestic(selected, environment, { run })).toMatchObject({ exitCode: 2, report: { complete: false, stage: "input" } });
    expect(run).not.toHaveBeenCalled();
  });

  it.each([1, 2, 3, 10, 11, 12, 99, null])("fails closed on backup exit %s, including a partial snapshot", async exitCode => {
    const run = runner().mockResolvedValueOnce(result(JSON.stringify({ message_type: "summary", snapshot_id: ID }), exitCode));
    expect(await performRestic(options(), environment, { run, clock: () => NOW, host: HOST })).toMatchObject({
      exitCode: 2, report: { complete: false, stage: "backup", knownSnapshotId: ID, dataVerified: false },
    });
    expect(run).toHaveBeenCalledOnce();
  });

  it("reports the known partial snapshot even when backup status contains read errors", async () => {
    const output = '{"message_type":"status","error_count":1}\n' + JSON.stringify({ message_type: "summary", snapshot_id: ID });
    const run = runner().mockResolvedValueOnce(result(output, 3));
    expect(await performRestic(options(), environment, { run, host: HOST })).toMatchObject({
      exitCode: 2, report: { complete: false, stage: "backup", knownSnapshotId: ID },
    });
  });

  it.each([
    '{"message_type":"summary"}', '{"message_type":"summary","snapshot_id":"abcdef12"}',
    JSON.stringify({ message_type: "summary", snapshot_id: ID, dry_run: true }),
    '{"message_type":"summary"}\n{"message_type":"summary"}', 'invalid json',
    '{"message_type":"summary"}\n{"message_type":"status"}',
    '{"message_type":"status","error_count":1}\n{"message_type":"summary"}',
  ])("does not accept a missing or invalid new snapshot summary", async stdout => {
    const run = runner().mockResolvedValueOnce(result(stdout));
    expect(await performRestic(options(), environment, { run, host: HOST })).toMatchObject({ exitCode: 2, report: { complete: false, stage: "backup" } });
    expect(run).toHaveBeenCalledOnce();
  });

  it.each([
    { id: "b".repeat(64) }, { hostname: "other-host" }, { tags: ["rimo-service:other"] },
    { tags: [TAG, "extra"] }, { paths: ["/other/source"] }, { paths: ["/one", "/two"] },
    { time: new Date(NOW - 61_000).toISOString() }, { time: new Date(NOW + 61_000).toISOString() },
  ])("rejects mismatched exact snapshot metadata: %j", async changes => {
    const run = runner();
    run.mockImplementation(async args => args[0] === "backup"
      ? result(JSON.stringify({ message_type: "summary", snapshot_id: ID })) : result(JSON.stringify([snapshot(changes)])));
    expect(await performRestic(options(), environment, { run, clock: () => NOW, host: HOST })).toMatchObject({
      exitCode: 2, report: { complete: false, stage: "snapshot", knownSnapshotId: ID },
    });
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("retains the known snapshot ID when data verification fails and suppresses raw errors", async () => {
    const run = runner();
    run.mockImplementation(async args => {
      if (args[0] === "check") throw new Error(`private stderr ${input} ${environment.RESTIC_REPOSITORY}`);
      return args[0] === "backup" ? result(JSON.stringify({ message_type: "summary", snapshot_id: ID })) : result(JSON.stringify([snapshot()]));
    });
    const failure = await performRestic(options(), environment, { run, clock: () => NOW, host: HOST });
    expect(failure).toMatchObject({ exitCode: 2, report: { complete: false, stage: "check", knownSnapshotId: ID, dataVerified: false } });
    expect(JSON.stringify(failure)).not.toContain("private");
    expect(JSON.stringify(failure)).not.toContain(input);
  });

  it("checks both the restic check exit and its summary error count", async () => {
    for (const checked of [result('{"message_type":"summary","num_errors":0}', 1),
      ...[undefined, null, "0", -1, 1].map(num_errors => result(JSON.stringify({ message_type: "summary", num_errors })))]) {
      const run = runner();
      const successful = runner();
      run.mockImplementation(args => args[0] === "check" ? Promise.resolve(checked) : successful(args));
      expect(await performRestic(options(), environment, { run, clock: () => NOW, host: HOST })).toMatchObject({
        exitCode: 2, report: { complete: false, stage: "check", knownSnapshotId: ID },
      });
    }
  });

  it("detects a changed local manifest after upload", async () => {
    const local = await verifyLocalBackup(input, "rimo");
    const verify = vi.fn().mockResolvedValueOnce(local).mockResolvedValueOnce({ ...local, manifest: { ...local.manifest, image: "changed" } });
    const run = runner();
    expect(await performRestic(options(), environment, { run, verify, clock: () => NOW, host: HOST })).toMatchObject({
      exitCode: 2, report: { complete: false, stage: "input-recheck", knownSnapshotId: ID },
    });
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("records the capture time and warns after re-uploading a completed old dump", async () => {
    const local = await verifyLocalBackup(input, "rimo");
    await writeFile(path.join(input, "manifest.json"), JSON.stringify({ ...local.manifest, capturedAt: new Date(NOW - 7 * MAX_AGE_MS).toISOString() }));
    const run = runner();
    const successful = runner();
    run.mockImplementation(args => args[0] === "snapshots"
      ? Promise.resolve(result(JSON.stringify([snapshot({ tags: [TAG, sourceTag(NOW - 7 * MAX_AGE_MS)] })]))) : successful(args));
    expect(await performRestic(options(), environment, { run, clock: () => NOW, host: HOST }))
      .toMatchObject({ exitCode: 1, report: { complete: true, dataVerified: true, status: "stale", ageSeconds: 7 * 24 * 3_600 } });
    expect(run.mock.calls[0][0]).toContain(sourceTag(NOW - 7 * MAX_AGE_MS));
  });

  it("rejects a capture timestamp that follows completion beyond clock tolerance", async () => {
    const local = await verifyLocalBackup(input, "rimo");
    await writeFile(path.join(input, "manifest.json"), JSON.stringify({ ...local.manifest,
      createdAt: new Date(NOW - 7 * MAX_AGE_MS).toISOString(), capturedAt: new Date(NOW).toISOString() }));
    const run = runner();
    expect(await performRestic(options(), environment, { run, clock: () => NOW, host: HOST }))
      .toMatchObject({ exitCode: 2, report: { complete: false, stage: "input" } });
    expect(run).not.toHaveBeenCalled();
  });
});

describe("snapshot age without a local backup directory", () => {
  it("does not refresh week-old source data by uploading it today", async () => {
    const run = vi.fn(async () => result(JSON.stringify([snapshot({ tags: [TAG, sourceTag(NOW - 7 * MAX_AGE_MS)] })])));
    expect(await performRestic({ project: "rimo", checkAge: true }, environment, { run, clock: () => NOW, host: HOST }))
      .toMatchObject({ exitCode: 1, report: { status: "stale", sourceCreatedAt: new Date(NOW - 7 * MAX_AGE_MS).toISOString() } });
  });

  it("chooses the freshest source data when a newer transfer contains an older dump", async () => {
    const run = vi.fn(async () => result(JSON.stringify([
      snapshot({ tags: [TAG, sourceTag(NOW - 7 * MAX_AGE_MS)] }),
      snapshot({ id: "b".repeat(64), time: new Date(NOW - 3_600_000).toISOString() }),
    ])));
    expect(await performRestic({ project: "rimo", checkAge: true }, environment, { run, clock: () => NOW, host: HOST }))
      .toMatchObject({ exitCode: 0, report: { status: "fresh", snapshotID: "b".repeat(64), ageSeconds: 3_600 } });
  });

  it.each([[TAG], [TAG, "rimo-source:invalid"], [TAG, sourceTag(NOW), sourceTag(NOW - 1_000)]].map(tags => ({ tags })))
    ("rejects absent, malformed or ambiguous source-time metadata: $tags", async ({ tags }) => {
      const run = vi.fn(async () => result(JSON.stringify([snapshot({ tags })])));
      expect(await performRestic({ project: "rimo", checkAge: true }, environment, { run, clock: () => NOW, host: HOST }))
        .toMatchObject({ exitCode: 2, report: { complete: false, stage: "age", errorCode: "INVALID_SOURCE_TIME" } });
    });

  it.each([
    { age: MAX_AGE_MS, status: "fresh", exitCode: 0 }, { age: MAX_AGE_MS + 1_000, status: "stale", exitCode: 1 },
    { age: -30_000, status: "fresh", exitCode: 0 }, { age: -61_000, status: "future", exitCode: 1 },
  ])("classifies $status using the 24-hour boundary and a limited clock tolerance", async ({ age, status, exitCode }) => {
    const run = vi.fn(async (args: string[]) => {
      expect(args[0]).toBe("snapshots");
      return result(JSON.stringify([snapshot({ time: new Date(NOW - age).toISOString(), paths: ["/deleted/daily-copy"] })]));
    });
    const verify = vi.fn();
    expect(await performRestic({ project: "rimo", checkAge: true }, environment, { run, verify, clock: () => NOW, host: HOST })).toMatchObject({
      exitCode, report: { complete: true, mode: "check-age", status, dataVerified: false, offsiteVerified: false },
    });
    expect(verify).not.toHaveBeenCalled();
    expect(run.mock.calls[0][0]).toEqual(["snapshots", "--json", "--host", HOST, "--tag", TAG]);
  });

  it("does not let another project or host make this project's old snapshot look fresh", async () => {
    const run = vi.fn(async () => result(JSON.stringify([
      snapshot({ hostname: "other" }), snapshot({ tags: ["rimo-service:other"] }), snapshot({ time: new Date(NOW - MAX_AGE_MS - 1_000).toISOString() }),
    ])));
    expect(await performRestic({ project: "rimo", checkAge: true }, environment, { run, clock: () => NOW, host: HOST })).toMatchObject({
      exitCode: 1, report: { status: "stale" },
    });
  });

  it.each(["[]", "not-json", '[{"id":"short"}]'])("handles absent or malformed metadata safely: %s", async stdout => {
    const completed = await performRestic({ project: "rimo", checkAge: true }, environment, { run: async () => result(stdout), host: HOST });
    expect(completed.exitCode).toBe(stdout === "[]" ? 1 : 2);
    expect(completed.report).toMatchObject(stdout === "[]" ? { complete: true, status: "missing" } : { complete: false, stage: "age" });
  });
});

describe("bounded restic subprocess", () => {
  function subprocess() {
    const events = new EventEmitter();
    const child = Object.assign(events, { stdout: new PassThrough(), stderr: new PassThrough(),
      kill: vi.fn(() => { queueMicrotask(() => events.emit("close", null, "SIGTERM")); return true; }), unref: vi.fn() });
    const spawnProcess = vi.fn(() => child);
    return { child, spawnProcess, start: (signal?: AbortSignal, timeoutMs = 1_000, maxOutputBytes = 128) =>
      runRestic(["check", "--json", "--read-data"], environment, signal, timeoutMs,
        { spawnProcess: spawnProcess as unknown as typeof spawn, maxOutputBytes, killGraceMs: 5 }) };
  }

  it("passes fixed argv without a shell and never forwards stderr", async () => {
    const mock = subprocess();
    const pending = mock.start();
    mock.child.stderr.write("private-path-and-repository");
    mock.child.stdout.write("{}");
    mock.child.emit("close", 0, null);
    expect(await pending).toEqual(result("{}"));
    expect(mock.spawnProcess).toHaveBeenCalledWith("restic", ["check", "--json", "--read-data"], expect.objectContaining({
      shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
    }));
  });

  it("bounds the combined stdout/stderr size and cancels the child", async () => {
    const mock = subprocess();
    const pending = mock.start(undefined, 1_000, 10);
    mock.child.stderr.write("private-output-too-large");
    await expect(pending).rejects.toThrow("RESTIC_OUTPUT_LIMIT");
    expect(mock.child.kill).toHaveBeenCalled();
  });

  it("terminates on deadline and on in-flight cancellation", async () => {
    vi.useFakeTimers();
    const mock = subprocess();
    const pending = expect(mock.start(undefined, 10)).rejects.toThrow("RESTIC_TIMEOUT");
    await vi.advanceTimersByTimeAsync(10);
    await pending;
    const controller = new AbortController();
    const second = subprocess();
    const cancelled = expect(second.start(controller.signal)).rejects.toThrow("CANCELLED");
    controller.abort();
    await vi.advanceTimersByTimeAsync(0);
    await cancelled;
  });

  it("fails immediately for an already cancelled operation without spawning restic", async () => {
    const controller = new AbortController(); controller.abort();
    const mock = subprocess();
    await expect(mock.start(controller.signal)).rejects.toThrow("CANCELLED");
    expect(mock.spawnProcess).not.toHaveBeenCalled();
  });

  it("remains bounded when the child ignores both termination signals", async () => {
    vi.useFakeTimers();
    const mock = subprocess();
    mock.child.kill.mockImplementation(() => true);
    const pending = expect(mock.start(undefined, 10)).rejects.toThrow("RESTIC_TIMEOUT");
    await vi.advanceTimersByTimeAsync(20);
    await pending;
    expect(mock.child.kill).toHaveBeenCalledWith("SIGKILL");
    expect(mock.child.unref).toHaveBeenCalledOnce();
  });
});
