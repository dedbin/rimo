/** Keep graceful interruption inside the normal cleanup/report boundary. */
export function createRunLifecycle(defaultDeadlineMs, onInterrupt) {
  const deadlineMs = Number(process.env.RIMO_NETWORK_DEADLINE_MS ?? defaultDeadlineMs);
  if (!Number.isSafeInteger(deadlineMs) || deadlineMs < 1 || deadlineMs > defaultDeadlineMs) {
    throw new Error(`RIMO_NETWORK_DEADLINE_MS must be between 1 and ${defaultDeadlineMs}`);
  }
  const controller = new AbortController();
  let interruption;
  const request = (reason) => {
    if (controller.signal.aborted) return;
    interruption = { reason, at: new Date().toISOString() };
    process.exitCode = reason === "SIGINT" ? 130 : reason === "SIGTERM" ? 143 : 124;
    controller.abort(new Error(`Network run interrupted: ${reason}`));
    // Closing active consumers rejects pending Playwright operations into finally.
    void Promise.resolve().then(onInterrupt).catch(() => undefined);
  };
  const interrupt = () => request("SIGINT");
  const terminate = () => request("SIGTERM");
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", terminate);
  const watchdog = setTimeout(() => request("deadline"), deadlineMs);
  return {
    signal: controller.signal,
    check() { controller.signal.throwIfAborted(); },
    apply(report) {
      if (interruption) {
        report.status = "interrupted"; report.interruption = interruption;
        process.exitCode = interruption.reason === "SIGINT" ? 130 : interruption.reason === "SIGTERM" ? 143 : 124;
      }
    },
    async finalize(report, write) {
      this.apply(report);
      const alreadyInterrupted = controller.signal.aborted;
      await write();
      if (!alreadyInterrupted && controller.signal.aborted) {
        this.apply(report);
        await write();
      }
    },
    dispose() {
      clearTimeout(watchdog);
      process.off("SIGINT", interrupt);
      process.off("SIGTERM", terminate);
    },
  };
}
