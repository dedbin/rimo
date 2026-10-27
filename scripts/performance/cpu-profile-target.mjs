// Executed by the host harness inside its own collaboration container.
import { readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";

const seconds = Number(process.argv[1]);
if (!Number.isSafeInteger(seconds) || seconds < 1 || seconds > 300) throw new Error("Invalid profile duration");
const controller = new AbortController();
const interrupt = () => controller.abort();
process.stdin.on("data", interrupt);
process.stdin.on("end", interrupt);
process.stdin.resume();
process.on("SIGINT", interrupt);
process.on("SIGTERM", interrupt);

async function probe() {
  try { return await fetch("http://127.0.0.1:9229/json/list", { signal: AbortSignal.timeout(500) }); }
  catch (error) { if (error.cause?.code === "ECONNREFUSED") return null; throw new Error("Inspector probe failed"); }
}

async function connect() {
  const targets = await (await probe()).json();
  const endpoint = new URL(targets.find((entry) => entry.type === "node")?.webSocketDebuggerUrl);
  if (endpoint.hostname !== "127.0.0.1" || endpoint.port !== "9229" || endpoint.protocol !== "ws:") {
    throw new Error("Unexpected inspector address");
  }
  const socket = new WebSocket(endpoint);
  const pending = new Map();
  let sequence = 0;
  socket.addEventListener("message", (event) => {
    const response = JSON.parse(event.data);
    const entry = pending.get(response.id);
    if (!entry) return;
    pending.delete(response.id); clearTimeout(entry.timeout);
    if (response.error) entry.reject(new Error("Inspector command failed"));
    else entry.resolve(response.result);
  });
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Inspector connection timeout")), 5_000);
    socket.addEventListener("open", () => { clearTimeout(timeout); resolve(); }, { once: true });
    socket.addEventListener("error", () => { clearTimeout(timeout); reject(new Error("Inspector connection failed")); }, { once: true });
  });
  return {
    request(method, params = {}) {
      return new Promise((resolve, reject) => {
        const id = ++sequence;
        const timeout = setTimeout(() => { pending.delete(id); reject(new Error("Inspector command timeout")); }, 5_000);
        pending.set(id, { resolve, reject, timeout });
        socket.send(JSON.stringify({ id, method, params }));
      });
    },
    close() {
      for (const entry of pending.values()) { clearTimeout(entry.timeout); entry.reject(new Error("Inspector disconnected")); }
      pending.clear(); socket.close();
    },
  };
}

async function closeInspector(session) {
  let current = session;
  try {
    if (!await probe()) return true;
    try {
      current ??= await connect();
      await current.request("Runtime.evaluate", { expression:
        'setTimeout(()=>process.getBuiltinModule("node:inspector").close(),100);true' });
    } catch {
      current?.close(); current = await connect();
      await current.request("Runtime.evaluate", { expression:
        'setTimeout(()=>process.getBuiltinModule("node:inspector").close(),100);true' });
    }
  } finally { current?.close(); }
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) { if (!await probe()) return true; await delay(50); }
  return false;
}

let phase = "preflight";
let ownsInspector = false;
let session;
let result;
try {
  if ((await readFile("/proc/1/comm", "utf8")).trim() !== "node") throw new Error("PID1 must be Node");
  if (await probe()) throw new Error("Inspector already active");
  phase = "enable";
  process.kill(1, "SIGUSR1"); ownsInspector = true;
  const deadline = Date.now() + 5_000;
  while (!await probe()) { if (Date.now() > deadline) throw new Error("Inspector did not start"); await delay(50); }
  session = await connect();
  await session.request("Profiler.enable");
  await session.request("Profiler.setSamplingInterval", { interval: 1_000 });
  const startedAt = new Date().toISOString();
  await session.request("Profiler.start");
  phase = "record";
  process.stdout.write(`${JSON.stringify({ event: "cpu_profile_started", startedAt, seconds })}\n`);
  await delay(seconds * 1_000, undefined, { signal: controller.signal }).catch((error) => {
    if (error.name !== "AbortError") throw error;
  });
  phase = "stop";
  const { profile } = await session.request("Profiler.stop");
  result = { event: "cpu_profile_complete", startedAt, interrupted: controller.signal.aborted, profile };
} catch { result = { event: "cpu_profile_error", phase }; process.exitCode = 1; }
finally {
  let inspectorClosed = false;
  if (ownsInspector) {
    try { inspectorClosed = await closeInspector(session); }
    catch { session?.close(); }
  }
  else { try { inspectorClosed = !await probe(); } catch { /* Preserve a pre-existing inspector. */ } }
  if (!inspectorClosed) process.exitCode = 1;
  process.stdout.write(`${JSON.stringify({ ...result, inspectorClosed })}\n`);
  process.stdin.pause();
}
