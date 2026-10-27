import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";

import type { PostgresResource } from "./postgres-resource-compose";
import { POSTGRES_PERSISTENCE_FAILURE } from "./postgres-resource-fixtures";

interface ResourceEvent {
  readonly phase: string;
  readonly [key: string]: unknown;
}

export function startPostgresFixture(context: PostgresResource) {
  const child = spawn("docker", [...context.args, "exec", "-T", "harness", "node", "--import=tsx", "--input-type=module", "-e", POSTGRES_PERSISTENCE_FAILURE], {
    env: context.environment, stdio: ["pipe", "pipe", "pipe"], shell: false, windowsHide: true,
  });
  const events = new Map<string, ResourceEvent>();
  const pending = new Map<string, { resolve: (event: ResourceEvent) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  const decoder = new StringDecoder("utf8");
  let remainder = "";
  let diagnostics = "";
  let size = 0;
  let finished = false;
  let failure: Error | undefined;
  const rejectPending = (error: Error): void => {
    for (const waiter of pending.values()) { clearTimeout(waiter.timer); waiter.reject(error); }
    pending.clear();
  };
  const terminate = (message: string): void => {
    failure = new Error(message);
    rejectPending(failure);
    child.kill("SIGKILL");
  };
  const deadline = setTimeout(() => terminate("PostgreSQL resource fixture deadline exceeded"), 100_000);
  const count = (chunk: Buffer): boolean => {
    size += chunk.length;
    if (size > 524_288) { terminate("PostgreSQL resource fixture output limit exceeded"); return false; }
    return true;
  };
  child.stdout.on("data", (chunk: Buffer) => {
    if (!count(chunk)) return;
    remainder += decoder.write(chunk);
    const lines = remainder.split("\n");
    remainder = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.startsWith("RIMO_PG_EVENT ")) continue;
      let event: ResourceEvent;
      try { event = JSON.parse(line.slice(14)) as ResourceEvent; } catch { terminate("Invalid PostgreSQL resource fixture event"); return; }
      if (!["baseline", "failure", "recovered", "reloaded", "fixture-error"].includes(event.phase)) { terminate("Unexpected PostgreSQL resource phase"); return; }
      if (event.phase === "fixture-error") {
        const phase = ["baseline", "failure", "recovered", "reloaded"].includes(String(event.failedPhase)) ? event.failedPhase : "unknown";
        terminate(`PostgreSQL resource fixture failed during ${phase}`);
        return;
      }
      events.set(event.phase, event);
      const waiter = pending.get(event.phase);
      if (waiter) { clearTimeout(waiter.timer); pending.delete(event.phase); waiter.resolve(event); }
    }
  });
  child.stderr.on("data", (chunk: Buffer) => {
    if (count(chunk)) diagnostics = (diagnostics + chunk.toString("utf8")).slice(-8_192);
  });
  child.stdin.on("error", () => undefined);
  const done = new Promise<void>((resolve, reject) => {
    child.once("error", () => { failure = new Error("PostgreSQL resource fixture could not spawn"); rejectPending(failure); clearTimeout(deadline); reject(failure); });
    child.once("close", (code) => {
      finished = true;
      clearTimeout(deadline);
      if (code !== 0 && !failure) {
        const phase = [...events.keys()].at(-1) ?? "startup";
        const error = diagnostics.match(/\b(SyntaxError|TypeError|ReferenceError|RangeError|Error)(?: \[([A-Z][A-Z0-9_]{1,39})\])?:/);
        const reason = /Cannot find module|Cannot find package/.test(diagnostics) ? "module_missing"
          : /does not provide an export named/.test(diagnostics) ? "module_export" : "unclassified";
        failure = new Error(`PostgreSQL resource fixture exited (${code}); phase=${phase}; error=${error?.[1] ?? "unknown"}; code=${error?.[2] ?? "none"}; reason=${reason}`);
      }
      if (failure) { rejectPending(failure); reject(failure); }
      else { rejectPending(new Error("PostgreSQL resource fixture closed before its expected event")); resolve(); }
    });
  });
  void done.catch(() => undefined);
  return {
    done,
    send(command: "edit" | "recover"): void { child.stdin.write(Buffer.from(`${JSON.stringify({ command })}\n`)); },
    event(phase: "baseline" | "failure" | "recovered" | "reloaded", timeoutMs = 25_000): Promise<ResourceEvent> {
      const event = events.get(phase);
      if (event) return Promise.resolve(event);
      if (failure || finished) return Promise.reject(failure ?? new Error("PostgreSQL resource fixture already closed"));
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(phase); reject(new Error(`PostgreSQL resource phase deadline exceeded: ${phase}`)); }, timeoutMs);
        pending.set(phase, { resolve, reject, timer });
      });
    },
    async stop(): Promise<void> {
      child.stdin.end();
      if (!finished) child.kill("SIGKILL");
      await done.catch(() => undefined);
    },
    closeInput(): void { child.stdin.end(); },
  };
}
