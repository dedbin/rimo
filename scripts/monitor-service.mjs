import { isCliEntry } from "./cli-entry.mjs";
import { aggregate, APP_STATUS_SCRIPT, createDockerRunner, critical, exitCode, INSPECT_FORMAT, LIMITS, MonitorError,
  monitorEnvironment, monitorOptions, parseAppStatus, parseCollaborationLogs, parseContainers, parseFilesystems,
  parseIds, parsePdfHealth, PDF_HEALTH_SCRIPT, PG_FILESYSTEM_SCRIPT, SERVICES, successful } from "./monitor-common.mjs";

/** One bounded observation. The injected runner is for isolated tests, never a CLI option. */
export async function monitorService(options, { run, signal, now = () => new Date() }) {
  const checkedAt = now().toISOString();
  const checks = { containers: critical("CHECK_PENDING"), application: critical("CHECK_PENDING"),
    postgresFilesystems: critical("CHECK_PENDING"), pdfQueue: critical("CHECK_PENDING"), collaborationEvents: critical("CHECK_PENDING") };
  const report = { version: 1, checkedAt, project: options.project, status: "critical", reasonCodes: [], limits: { ...LIMITS }, checks };
  const observe = async (fallback, operation) => {
    const started = performance.now();
    try {
      signal?.throwIfAborted();
      return { ...await operation(), durationMs: Math.round(performance.now() - started) };
    } catch (error) {
      const code = signal?.aborted ? "CHECK_INTERRUPTED" : error instanceof MonitorError ? error.code : fallback;
      return { ...critical(code), durationMs: Math.round(performance.now() - started) };
    }
  };
  checks.containers = await observe("CONTAINER_INVENTORY_INVALID", async () => {
    const prefix = ["compose", "--project-name", options.project, "--env-file", options.envFile, "--file", options.composeFile];
    const inventory = await run([...prefix, "ps", "--all", "--quiet", ...SERVICES]);
    const ids = parseIds(successful(inventory, "CONTAINER_INVENTORY_UNAVAILABLE"));
    const inspected = await run(["inspect", "--type", "container", "--format", INSPECT_FORMAT, ...ids]);
    return parseContainers(successful(inspected, "CONTAINER_INSPECT_UNAVAILABLE"), options.project, ids);
  });
  const container = (service) => checks.containers.data?.find((row) => row.service === service)?.data;
  const operations = [
    ["application", "APP_STATUS_INVALID", async () => {
      const target = container("app");
      if (!target || target.state !== "running") return critical("APP_CONTAINER_UNAVAILABLE");
      const response = await run(["exec", "--workdir", "/app", target.id, "node", "--import=tsx", "--input-type=module", "-e", APP_STATUS_SCRIPT]);
      return parseAppStatus(response);
    }],
    ["postgresFilesystems", "POSTGRES_FILESYSTEM_INVALID", async () => {
      const target = container("db");
      if (!target || target.state !== "running") return critical("POSTGRES_CONTAINER_UNAVAILABLE");
      const response = await run(["exec", "--user", "postgres", target.id, "timeout", "--signal=TERM", "--kill-after=1s", "6s", "sh", "-c", PG_FILESYSTEM_SCRIPT]);
      return parseFilesystems(successful(response, "POSTGRES_FILESYSTEM_UNAVAILABLE"));
    }],
    ["pdfQueue", "PDF_HEALTH_INVALID", async () => {
      const target = container("export-worker");
      if (!target || target.state !== "running") return critical("PDF_CONTAINER_UNAVAILABLE");
      const response = await run(["exec", "--workdir", "/app", target.id, "node", "--input-type=module", "-e", PDF_HEALTH_SCRIPT]);
      return parsePdfHealth(successful(response, "PDF_HEALTH_UNAVAILABLE"));
    }],
    ["collaborationEvents", "COLLABORATION_LOGS_INVALID", async () => {
      const target = container("collaboration");
      if (!target) return critical("COLLABORATION_CONTAINER_UNAVAILABLE");
      const since = new Date(Date.parse(checkedAt) - LIMITS.logWindowSeconds * 1_000).toISOString();
      const response = await run(["logs", "--since", since, "--tail", String(LIMITS.logLines), target.id], { logs: true });
      successful(response, "COLLABORATION_LOGS_UNAVAILABLE");
      return parseCollaborationLogs(response.stdout, response.stderr);
    }],
  ];
  // An unavailable dependency cannot skip the other independent observations.
  await Promise.allSettled(operations.map(async ([name, fallback, operation]) => { checks[name] = await observe(fallback, operation); }));
  for (const [name] of operations) checks[name] ??= critical("CHECK_UNAVAILABLE");
  Object.assign(report, aggregate(checks));
  if (signal?.aborted) { report.status = "critical"; report.reasonCodes.push("MONITOR_INTERRUPTED_OR_DEADLINE"); }
  return report;
}

export async function main(args = process.argv.slice(2)) {
  let options; let report;
  const controller = new AbortController();
  const interrupt = () => controller.abort();
  const timer = setTimeout(() => controller.abort(), LIMITS.deadlineMs);
  process.on("SIGINT", interrupt); process.on("SIGTERM", interrupt);
  try {
    options = monitorOptions(args);
    if (options.help) {
      process.stdout.write("node scripts/monitor-service.mjs --project NAME --env-file PRIVATE_FILE --compose-file COMPOSE_FILE\nOne read-only JSON observation; exit 0 healthy, 1 warning, 2 critical.\n");
      return;
    }
    const environment = await monitorEnvironment(options, controller.signal);
    report = await monitorService(options, { run: createDockerRunner({ environment, signal: controller.signal }), signal: controller.signal });
  } catch (error) {
    report = { version: 1, checkedAt: new Date().toISOString(), project: options?.project ?? null, status: "critical",
      reasonCodes: [error instanceof MonitorError ? error.code : "CONFIGURATION_OR_MONITOR_FAILED"], limits: { ...LIMITS }, checks: {} };
  } finally {
    clearTimeout(timer);
    if (report) {
      if (controller.signal.aborted) { report.status = "critical"; report.reasonCodes = [...new Set([...report.reasonCodes, "MONITOR_INTERRUPTED_OR_DEADLINE"])]; }
      process.exitCode = exitCode(report.status);
      process.stdout.write(`${JSON.stringify(report)}\n`);
    }
    process.off("SIGINT", interrupt); process.off("SIGTERM", interrupt);
  }
}

if (await isCliEntry(import.meta.url)) {
  process.stdout.on("error", () => { process.exitCode = 2; });
  await main();
}
