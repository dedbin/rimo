// @vitest-environment node
import { execFile, type spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { PassThrough } from "node:stream";
import { promisify } from "node:util";

import { describe, expect, it, vi } from "vitest";

import { aggregate, APP_STATUS_SCRIPT, createDockerRunner, exitCode, INSPECT_FORMAT, LIMITS, monitorEnvironment,
  monitorOptions, parseAppStatus, parseCollaborationLogs, parseContainers, parseFilesystems, parseIds, parsePdfHealth,
  PDF_HEALTH_SCRIPT, PG_FILESYSTEM_SCRIPT, SERVICES } from "../scripts/monitor-common.mjs";
import { monitorService } from "../scripts/monitor-service.mjs";

const sentinel = "private-marker-must-never-reach-report";
const GiB = 1024 ** 3;
const options = { project: "monitor-fixture", envFile: path.resolve("temp/monitor.env"), composeFile: path.resolve("docker-compose.yml") };
type Response = { code: number | null; stdout: string; stderr: string; problem?: string };
const response = (stdout: string, code = 0): Response => ({ code, stdout, stderr: sentinel });
function appBody() {
  return { version: 1, checkedAt: "2026-10-27T00:00:00.000Z", status: "healthy", reasonCodes: [] as string[], database: { reachable: true },
    usage: { owners: 1, boards: 1, documents: 1, documentBytes: 100, assets: 1, assetBytes: 100,
      maxBoardsPerOwner: 1, maxOwnerAssetBytes: 100, maxBoardAssetBytes: 100 },
    quotas: { maxOwners: 6, maxBoardsPerOwner: 20, maxBoardAssetBytes: 1000, maxOwnerAssetBytes: 1000, maxGlobalAssetBytes: 10_000, maxGlobalDocumentBytes: 10_000 },
    storage: { readable: true, writable: true, freeBytes: 4 * GiB, totalBytes: 16 * GiB, regularFileCount: 1, fileBytes: 100, skippedDirectories: 0, skippedLinks: 0 } };
}
function containers() {
  return SERVICES.map((service, index) => ({ id: String(index + 1).repeat(64), project: options.project, service,
    state: "running", health: ["export-worker", "caddy"].includes(service) ? null : "healthy", restarts: 0, oomKilled: false }));
}
function containerResult(rows = containers()) {
  return parseContainers(rows.map((row) => JSON.stringify(row)).join("\n"), options.project, rows.map((row) => row.id));
}
function fakeRunner(overrides: { app?: Response; df?: Response; pdf?: Response; logs?: Response; rows?: ReturnType<typeof containers> } = {}) {
  const rows = overrides.rows ?? containers();
  return vi.fn(async (args: string[]): Promise<Response> => {
    if (args[0] === "compose") return response(rows.map((row) => row.id).join("\n"));
    if (args[0] === "inspect") return response(rows.map((row) => JSON.stringify(row)).join("\n"));
    if (args.includes(APP_STATUS_SCRIPT)) return overrides.app ?? response(JSON.stringify(appBody()));
    if (args.includes(PG_FILESYSTEM_SCRIPT)) return overrides.df ?? response(`${4 * GiB} ${16 * GiB}\n${4 * GiB} ${16 * GiB}\n`);
    if (args.includes(PDF_HEALTH_SCRIPT)) return overrides.pdf ?? response('{"ok":true,"running":false,"waiting":0}');
    if (args[0] === "logs") return overrides.logs ?? { code: 0, stdout: "", stderr: "" };
    throw new Error(sentinel);
  });
}

describe("one-shot Compose monitor", () => {
  it("requires explicit project and both private configuration paths", () => {
    expect(() => monitorOptions([])).toThrow("CONFIGURATION_INVALID");
    expect(() => monitorOptions(["--project", "monitor-fixture", "--env-file", "private.env"])).toThrow("CONFIGURATION_INVALID");
    expect(() => monitorOptions(["--project", "bad;project", "--env-file", "private.env", "--compose-file", "compose.yml"])).toThrow("CONFIGURATION_INVALID");
    expect(monitorOptions(["--help"])).toEqual({ help: true });
    expect(monitorOptions(["--project", "fixture", "--env-file", "private.env", "--compose-file", "compose.yml"], path.resolve("temp")))
      .toMatchObject({ project: "fixture", envFile: path.resolve("temp/private.env"), composeFile: path.resolve("temp/compose.yml") });
  });

  it("makes the selected env file authoritative without exporting its secrets", async () => {
    const parent = path.resolve("temp"); const directory = await mkdtemp(path.join(parent, "monitor-unit-"));
    try {
      const envFile = path.join(directory, "private.env"); const composeFile = path.join(directory, "compose.yml");
      await writeFile(envFile, `PRIVATE_SETTING=${sentinel}\n`, { mode: 0o600 }); await writeFile(composeFile, "services: {}\n");
      const inherited = { PRIVATE_SETTING: "stale", KEEP_SETTING: "kept" };
      const environment = await monitorEnvironment({ envFile, composeFile }, new AbortController().signal, inherited);
      expect(environment.PRIVATE_SETTING).toBeUndefined(); expect(environment.KEEP_SETTING).toBe("kept");
      expect(JSON.stringify(environment)).not.toContain(sentinel); expect(inherited.PRIVATE_SETTING).toBe("stale");
    } finally {
      if (path.dirname(directory) !== parent) throw new Error("Unexpected monitor unit directory");
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("returns one safe healthy observation with only selected services and read-only commands", async () => {
    const run = fakeRunner();
    const report = await monitorService(options, { run, signal: new AbortController().signal, now: () => new Date("2026-10-27T00:05:00Z") });
    expect(report.status).toBe("healthy"); expect(exitCode(report.status)).toBe(0);
    expect(Object.keys(report.checks)).toHaveLength(5);
    expect(JSON.stringify(report)).not.toContain(sentinel);
    expect(run.mock.calls[0][0]).toEqual(["compose", "--project-name", options.project, "--env-file", options.envFile, "--file", options.composeFile,
      "ps", "--all", "--quiet", ...SERVICES]);
    expect(INSPECT_FORMAT).not.toContain(".Config.Env");
    expect(run.mock.calls.every(([args]) => ["compose", "inspect", "exec", "logs"].includes(args[0]))).toBe(true);
    const logArgs = run.mock.calls.find(([args]) => args[0] === "logs")![0];
    expect(logArgs).toContain("2026-10-27T00:00:00.000Z"); expect(logArgs).toContain(String(LIMITS.logLines));
  });

  it("keeps app exit 1 as warning and rejects a JSON/exit disagreement", async () => {
    const base = appBody();
    const body = { ...base, usage: { ...base.usage, owners: 6 }, status: "warning", reasonCodes: ["OWNERS_LIMIT_REACHED"] };
    expect(parseAppStatus(response(JSON.stringify(body), 1)).status).toBe("warning");
    const report = await monitorService(options, { run: fakeRunner({ app: response(JSON.stringify(body), 1) }), signal: new AbortController().signal });
    expect(report.status).toBe("warning"); expect(exitCode(report.status)).toBe(1);
    expect(() => parseAppStatus(response(JSON.stringify(body), 0))).toThrow("APP_STATUS_EXIT_MISMATCH");
    expect(() => parseAppStatus(response(JSON.stringify(appBody()), 1))).toThrow("APP_STATUS_EXIT_MISMATCH");
  });

  it("drops additional fields and accepts the existing minimal critical app error", () => {
    const body = { ...appBody(), token: sentinel, storage: { ...appBody().storage, internalPath: sentinel } };
    expect(JSON.stringify(parseAppStatus(response(JSON.stringify(body))))).not.toContain(sentinel);
    expect(parseAppStatus(response(JSON.stringify({ version: 1, checkedAt: "2026-10-27T00:00:00Z", status: "critical", reasonCodes: ["CONFIGURATION_OR_STATUS_FAILED"] }), 2)).status).toBe("critical");
    expect(() => parseAppStatus(response(JSON.stringify({ ...body, reasonCodes: [sentinel] })))).toThrow("APP_STATUS_INVALID");
  });

  it("never inspects another project or silently selects an ambiguous service", () => {
    const rows = containers(); rows[0].project = "other-project";
    expect(() => containerResult(rows)).toThrow("CONTAINER_INVENTORY_INVALID");
    const duplicate = { ...containers()[0], id: "a".repeat(64) };
    expect(containerResult([...containers(), duplicate]).status).toBe("critical");
    expect(() => parseIds("short-id")).toThrow("CONTAINER_INVENTORY_INVALID");
  });

  it.each(["exited", "unhealthy", "restarts", "oom", "missing-health"])("reports container %s evidence", (problem) => {
    const rows = containers();
    if (problem === "exited") rows[0].state = "exited";
    if (problem === "unhealthy") rows[0].health = "unhealthy";
    if (problem === "restarts") rows[0].restarts = 1;
    if (problem === "oom") rows[0].oomKilled = true;
    if (problem === "missing-health") rows[0].health = null;
    expect(containerResult(rows).status).toBe(problem === "restarts" ? "warning" : "critical");
  });

  it("evaluates PGDATA and pg_wal independently and requires strictly numeric df output", () => {
    const report = parseFilesystems(`${4 * GiB} ${16 * GiB}\n0 ${16 * GiB}\n`);
    expect(report.status).toBe("critical"); expect(report.reasonCodes).toEqual(["PG_WAL_SPACE_CRITICAL"]);
    expect(parseFilesystems(`${GiB} ${16 * GiB}\n${4 * GiB} ${16 * GiB}`).status).toBe("warning");
    for (const invalid of ["Avail Size\n1 2", "1 2", "-1 2\n1 2", "3 2\n1 2", `${sentinel} 2\n1 2`]) {
      expect(() => parseFilesystems(invalid)).toThrow("POSTGRES_FILESYSTEM_INVALID");
    }
    expect(PG_FILESYSTEM_SCRIPT).toContain('"$PGDATA/pg_wal"');
    expect(PG_FILESYSTEM_SCRIPT).not.toMatch(/rm\s|mkfs|dd\s|fallocate/);
  });

  it("treats a running PDF as healthy and a nonempty queue as warning", () => {
    expect(parsePdfHealth('{"ok":true,"running":true,"waiting":0}').status).toBe("healthy");
    expect(parsePdfHealth('{"ok":true,"running":true,"waiting":1}').status).toBe("warning");
    expect(() => parsePdfHealth('{"ok":false,"running":true,"waiting":0}')).toThrow("PDF_HEALTH_INVALID");
    expect(JSON.stringify(parsePdfHealth(JSON.stringify({ ok: true, running: false, waiting: 0, token: sentinel })))).not.toContain(sentinel);
    expect(APP_STATUS_SCRIPT).toContain("process.exit(124)"); expect(PDF_HEALTH_SCRIPT).toContain("AbortSignal.timeout(5000)");
  });

  it("counts only known persistence and ACL failures from both log streams", () => {
    const logs = parseCollaborationLogs(`[onStoreDocument] Board persistence failed\n${sentinel}\n`, [
      JSON.stringify({ event: "collaboration_access_check_failed", kind: "timeout", elapsedMs: 3001, token: sentinel }),
      JSON.stringify({ event: "collaboration_access_check_failed", kind: "denied", elapsedMs: 4 }),
    ].join("\n"));
    expect(logs.status).toBe("critical"); expect(logs.data).toMatchObject({ persistenceFailureRecords: 1, acl: { timeout: 1, denied: 1 } });
    expect(JSON.stringify(logs)).not.toContain(sentinel);
    expect(parseCollaborationLogs("", JSON.stringify({ event: "collaboration_access_check_failed", kind: "denied", elapsedMs: 2 })).status).toBe("healthy");
    expect(parseCollaborationLogs("", JSON.stringify({ event: "collaboration_access_check_failed", kind: "editor-limit", elapsedMs: 2 })).status).toBe("healthy");
    expect(parseCollaborationLogs("", JSON.stringify({ event: "collaboration_access_check_failed", kind: "constructor", elapsedMs: 2 })).status).toBe("critical");
    expect(parseCollaborationLogs(Array.from({ length: LIMITS.logLines }, () => "ignored").join("\n"), "").status).toBe("critical");
  });

  it("keeps independent checks when one command fails and never forwards stderr", async () => {
    const report = await monitorService(options, { run: fakeRunner({ df: response("", 1) }), signal: new AbortController().signal });
    expect(report.status).toBe("critical"); expect(exitCode(report.status)).toBe(2);
    expect(report.checks.pdfQueue.status).toBe("healthy"); expect(report.checks.application.status).toBe("healthy");
    expect(JSON.stringify(report)).not.toContain(sentinel);
    const controller = new AbortController(); controller.abort();
    const interrupted = await monitorService(options, { run: fakeRunner(), signal: controller.signal });
    expect(interrupted.status).toBe("critical"); expect(interrupted.reasonCodes).toContain("MONITOR_INTERRUPTED_OR_DEADLINE");
    expect(exitCode("invalid-status")).toBe(2);
    expect(aggregate({ a: { status: "healthy", reasonCodes: [] }, b: { status: "critical", reasonCodes: ["UNAVAILABLE"] } }).status).toBe("critical");
  });

  it("bounds and redacts a real child process without Docker or a service", async () => {
    const run = createDockerRunner({ environment: { ...process.env, MONITOR_UNIT_VALUE: sentinel }, signal: new AbortController().signal, program: process.execPath });
    const value = await run(["-e", 'process.stderr.write(process.env.MONITOR_UNIT_VALUE);process.stdout.write("ok");process.exitCode=1;']);
    expect(value).toMatchObject({ code: 1, stdout: "ok", stderr: "" });
    const limited = await run(["-e", `process.stdout.write(Buffer.alloc(${LIMITS.outputBytes + 1},65));`]);
    expect(limited.problem).toBe("OUTPUT_LIMIT"); expect(limited.stdout).toBe("");
    const timeout = createDockerRunner({ environment: process.env, signal: new AbortController().signal, program: process.execPath, timeoutMs: 500 });
    expect((await timeout(["-e", "setInterval(()=>{},1000)"])).problem).toBe("TIMEOUT");
  });

  it.each(["stdout", "stderr"] as const)("terminates on a child %s stream error without exposing buffered data", async (stream) => {
    const events = new EventEmitter();
    const child = Object.assign(events, { stdout: new PassThrough(), stderr: new PassThrough(),
      kill: vi.fn(() => { queueMicrotask(() => events.emit("close", null)); return true; }), unref: vi.fn() });
    const run = createDockerRunner({ environment: {}, signal: new AbortController().signal,
      spawnProcess: (() => child) as unknown as typeof spawn });
    const pending = run(["logs"], { logs: true });
    child.stdout.write(sentinel); child.stderr.write(sentinel);
    child[stream].emit("error", new Error(sentinel));
    const value = await pending;
    expect(value).toMatchObject({ problem: "STREAM_FAILED", stdout: "", stderr: "" });
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");
    expect(JSON.stringify(value)).not.toContain(sentinel);
  });

  it("prints help or one safe critical JSON before Docker when required flags are missing", async () => {
    const execute = promisify(execFile); const script = path.resolve("scripts/monitor-service.mjs");
    const help = await execute(process.execPath, [script, "--help"], { windowsHide: true, timeout: 5_000 });
    expect(help.stdout).toContain("--project NAME"); expect(help.stderr).toBe("");
    const failure = await execute(process.execPath, [script], { windowsHide: true, timeout: 5_000 })
      .then(() => null, (error: { code: number; stdout: string; stderr: string }) => error);
    expect(failure?.code).toBe(2); expect(failure?.stderr).toBe("");
    expect(JSON.parse(failure!.stdout)).toMatchObject({ version: 1, status: "critical", reasonCodes: ["CONFIGURATION_INVALID"] });
    expect(failure!.stdout.trim().split("\n")).toHaveLength(1);
  });
});
