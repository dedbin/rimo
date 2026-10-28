import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

import { fail, waitFor } from "../common.mjs";
import { healthRecord } from "./causal.mjs";
import { hostNow } from "./clock.mjs";

/** @param {{ pid: number, argv: string[] }[]} processes */
export function selectWorkerProcessId(processes) {
  const matches = processes.filter(({ pid, argv }) => Number.isSafeInteger(pid) && pid > 0 &&
    argv.length === 3 && argv[0].split("/").at(-1) === "node" && argv[1] === "--import=tsx" &&
    ["export-worker/index.ts", "/app/export-worker/index.ts"].includes(argv[2]));
  if (matches.length !== 1) throw new Error("Worker process identity is unavailable or ambiguous");
  return matches[0].pid;
}

/** Read-only program sent to the existing worker. No environment or credentials. */
export const PROBE_SOURCE = `
  const { get, Agent } = await import('node:http');
  const { readFile, readdir } = await import('node:fs/promises');
  const { createInterface } = await import('node:readline');
  const selectWorkerProcessId = ${selectWorkerProcessId.toString()};
  const agent = new Agent({ keepAlive:true,maxSockets:1 });
  const output = value => process.stdout.write(JSON.stringify(value)+'\\n');
  let stopping=false, activeHealth=false, sequence=0;
  const memory = async id => {
    try {
      const processes = (await Promise.all((await readdir('/proc')).filter(name=>/^\\d+$/.test(name)).map(async name=>{
        try { return {pid:Number(name),argv:(await readFile('/proc/'+name+'/cmdline','utf8')).split('\\0').filter(Boolean)}; }
        catch { return null; }
      }))).filter(Boolean);
      const workerPid = selectWorkerProcessId(processes);
      const [current, peak, limit, pid1Status, workerStatus] = await Promise.all([
        readFile('/sys/fs/cgroup/memory.current','utf8'), readFile('/sys/fs/cgroup/memory.peak','utf8'),
        readFile('/sys/fs/cgroup/memory.max','utf8'), readFile('/proc/1/status','utf8'),readFile('/proc/'+workerPid+'/status','utf8')]);
      output({kind:'memory',id,atEpochMs:Date.now(),monotonicMs:performance.now(),cgroupCurrentBytes:Number(current),cgroupPeakBytes:Number(peak),
        cgroupLimitBytes:limit.trim()==='max'?null:Number(limit),pid1RssBytes:Number(/VmRSS:\\s+(\\d+)/.exec(pid1Status)?.[1]??0)*1024,
        workerPid,workerRssBytes:Number(/VmRSS:\\s+(\\d+)/.exec(workerStatus)?.[1]??0)*1024});
    } catch { output({kind:'memory',id,ok:false}); }
  };
  const health = () => new Promise(resolve => {
    let timer;
    const finish=value=>{clearTimeout(timer);resolve({ok:false,running:false,waiting:0,...value});};
    const request = get('http://127.0.0.1:3100/healthz',{agent},response=>{
      let body='';
      response.on('data',chunk=>{body+=chunk;if(body.length>1024)request.destroy();});
      response.on('end',()=>{
        try { const data=JSON.parse(body);finish({ok:response.statusCode===200&&data.ok===true,running:data.running,waiting:data.waiting}); }
        catch { finish({ok:false}); }
      });
      response.on('error',()=>finish({ok:false}));
      response.on('close',()=>finish({ok:false}));
    });
    timer=setTimeout(()=>{request.destroy();finish({ok:false});},500);
    request.on('error',()=>finish({ok:false}));
  });
  const input=createInterface({input:process.stdin});
  const stop=()=>{if(stopping)return;stopping=true;clearTimeout(deadline);input.close();process.stdin.destroy();agent.destroy();};
  const deadline=setTimeout(stop,600000);
  input.on('line',line=>{
    if(stopping)return;
    try { const command=JSON.parse(line);
      if(command.kind==='stop'){stop();return;}
      if(!Number.isSafeInteger(command.id)||command.id<=0)throw new Error('Invalid command');
      if(command.kind==='health'){
        if(activeHealth||sequence>=30000)throw new Error('Health budget exceeded');
        activeHealth=true;
        const startedMonotonicMs=performance.now();
        void health().then(state=>{if(!stopping)output({kind:'health',id:command.id,sequence:++sequence,
          atEpochMs:Date.now(),startedMonotonicMs,monotonicMs:performance.now(),...state});}).finally(()=>{activeHealth=false;});
      }else if(command.kind==='memory')void memory(command.id);
      else throw new Error('Invalid command kind');
    } catch { process.exitCode=1;stop(); }
  });
  input.on('close',stop);
  output({kind:'ready'});
`;

export async function startProbe(binding, signal) {
  const identifier = binding.worker.id;
  assert.match(identifier, /^[a-f0-9]{64}$/);
  const child = spawn("docker", ["exec", "--interactive", identifier, "node", "--input-type=module", "--eval", PROBE_SOURCE],
    { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  const samples = [];
  const memory = [];
  const pending = new Map();
  let ready = false;
  let failure;
  let ended = false;
  let stopping = false;
  let closePromise;
  let polling;
  let nextId = 0;
  const rejectPending = (error) => { for (const request of pending.values()) request.finish(error); };
  const recordFailure = () => { failure ??= fail("Worker probe returned an invalid correlated record"); rejectPending(failure); };
  const lines = createInterface({ input: child.stdout });
  lines.on("error", recordFailure);
  // Readline removes its input error handler on close; keep the pipe protected during teardown.
  child.stdout.on("error", recordFailure);
  child.stderr.on("error", recordFailure);
  lines.on("line", (line) => {
    if (stopping) return;
    try {
      const receivedAt = hostNow(); const receivedWallEpochMs = Date.now();
      if (line.length > 4_096) throw fail("Worker probe response exceeded its budget");
      const value = JSON.parse(line);
      if (value.kind === "ready" && !ready) { ready = true; return; }
      const request = pending.get(value.id);
      if (!request || value.kind !== request.kind) throw fail("Unexpected worker probe reply");
      if (value.kind === "health") {
        if (samples.length >= 30_000) throw fail("Worker probe sample budget exceeded");
        samples.push(healthRecord(value, request, samples.at(-1), receivedAt));
      } else {
        if (memory.length >= 1_200) throw fail("Worker memory probe budget exceeded");
        memory.push({ ...value, hostSentAt: request.hostSentAt, hostReceivedAt: receivedAt, hostWallEpochMs: receivedWallEpochMs });
      }
      request.finish(null, value);
    } catch { recordFailure(); }
  });
  child.stderr.resume();
  child.stdin.on("error", () => { if (!stopping) recordFailure(); });
  child.on("error", recordFailure);
  const exited = new Promise((resolve) => child.once("exit", (code) => {
    ended = true; if (code || !stopping) recordFailure(); resolve();
  }));
  const check = () => { if (failure) throw failure; };
  const command = async (kind) => {
    check();
    if (ended || stopping) throw fail("Worker probe stopped before the run completed");
    if (kind === "health" && [...pending.values()].some((entry) => entry.kind === "health")) throw fail("Only one health request may be in flight");
    const id = ++nextId;
    return new Promise((resolve, reject) => {
      const finish = (error, value) => {
        if (!pending.delete(id)) return;
        clearTimeout(timer); signal?.removeEventListener("abort", aborted);
        if (error) reject(error); else resolve(value);
      };
      const aborted = () => finish(fail("Worker probe control request interrupted"));
      const timer = setTimeout(() => finish(fail("Worker probe control request timed out")), 5_000);
      pending.set(id, { kind, id, hostSentAt: hostNow(), hostSentWallEpochMs: Date.now(), finish });
      signal?.addEventListener("abort", aborted, { once: true });
      if (signal?.aborted) { aborted(); return; }
      child.stdin.write(`${JSON.stringify({ kind, id })}\n`, (error) => { if (error) finish(fail("Worker probe control pipe failed")); });
    });
  };
  const poll = async () => {
    let lastMemory = hostNow();
    while (!stopping && !ended) {
      if (samples.length >= 30_000) throw fail("Worker probe sample budget exceeded");
      await command("health");
      const recordMemory = hostNow() - lastMemory >= 1_000;
      if (recordMemory) lastMemory = hostNow();
      await Promise.all([new Promise((resolve) => setTimeout(resolve, 25)), ...(recordMemory ? [command("memory")] : [])]);
    }
  };
  const close = () => closePromise ??= (async () => {
    stopping = true; rejectPending(fail("Worker probe stopped"));
    if (!ended) child.stdin.end(`${JSON.stringify({ kind: "stop" })}\n`);
    await polling;
    await Promise.race([exited, new Promise((resolve) => { const timer = setTimeout(resolve, 3_000); timer.unref(); })]);
    if (!ended) { child.kill(); throw fail("Worker probe stop could not be confirmed; stdin EOF and remote deadline bound its lifetime"); }
    lines.close();
    check();
  })();
  try {
    await waitFor(() => { check(); return ready; }, 10_000, signal);
    polling = poll().catch(() => { if (!stopping) recordFailure(); });
    await waitFor(() => { check(); return samples.length > 0; }, 5_000, signal);
    return { samples, memory, close, check, container: identifier,
      sequence: () => samples.at(-1)?.sequence ?? 0,
      async waitState(running, after = 0) {
        await waitFor(() => { check(); return samples.some((entry) => entry.sequence > after && entry.ok && entry.running === running && entry.waiting === 0); }, 5_000, signal);
      },
      async memoryNow() { return command("memory"); },
    };
  } catch (error) { await close().catch(() => undefined); throw error; }
}
