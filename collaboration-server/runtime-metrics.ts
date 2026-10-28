import { constants, monitorEventLoopDelay, PerformanceObserver } from "node:perf_hooks";
import type { PerformanceEntry } from "node:perf_hooks";
import { memoryUsage, uptime } from "node:process";
import { getHeapStatistics } from "node:v8";

/** Process-only counters: no documents, identities, requests, or environment. */
export class RuntimeMetrics {
  private readonly loop = monitorEventLoopDelay({ resolution: 20 });
  private readonly observer = new PerformanceObserver((list) => this.recordGc(list.getEntries()));
  private active = false;
  private gcCount = 0;
  private gcTotalMs = 0;
  private gcMaxMs = 0;
  private majorGcCount = 0;
  private majorGcTotalMs = 0;
  private majorGcMaxMs = 0;

  start(): void {
    if (this.active) return;
    this.active = true;
    this.loop.enable();
    this.observer.observe({ entryTypes: ["gc"] });
  }

  stop(): void {
    if (!this.active) return;
    this.recordGc(this.observer.takeRecords());
    this.observer.disconnect();
    this.loop.disable();
    this.active = false;
  }

  read(): Record<string, number | null> {
    this.recordGc(this.observer.takeRecords());
    const memory = memoryUsage();
    const samples = this.loop.count;
    // Lifetime counters: Docker health checks must not reset the load sampler's interval.
    return {
      version: 1, processUptimeMs: Math.floor(uptime() * 1_000),
      rssBytes: memory.rss, heapUsedBytes: memory.heapUsed,
      heapTotalBytes: memory.heapTotal, externalBytes: memory.external,
      arrayBuffersBytes: memory.arrayBuffers, heapLimitBytes: getHeapStatistics().heap_size_limit,
      eventLoopSamples: samples, eventLoopP95Ms: samples ? this.loop.percentile(95) / 1e6 : null,
      eventLoopMaxMs: samples ? this.loop.max / 1e6 : null,
      gcCount: this.gcCount, gcTotalMs: this.gcTotalMs, gcMaxMs: this.gcMaxMs,
      majorGcCount: this.majorGcCount, majorGcTotalMs: this.majorGcTotalMs, majorGcMaxMs: this.majorGcMaxMs,
    };
  }

  private recordGc(entries: readonly PerformanceEntry[]): void {
    for (const entry of entries) {
      if (entry.entryType !== "gc" || !Number.isFinite(entry.duration) || entry.duration < 0) continue;
      this.gcCount += 1;
      this.gcTotalMs += entry.duration;
      this.gcMaxMs = Math.max(this.gcMaxMs, entry.duration);
      const detail = (entry as PerformanceEntry & { detail?: { kind?: number } }).detail;
      if (detail?.kind !== constants.NODE_PERFORMANCE_GC_MAJOR) continue;
      this.majorGcCount += 1;
      this.majorGcTotalMs += entry.duration;
      this.majorGcMaxMs = Math.max(this.majorGcMaxMs, entry.duration);
    }
  }
}
