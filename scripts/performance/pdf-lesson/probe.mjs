import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

import { fail, waitFor } from "../common.mjs";
import { clockBounds } from "./criteria.mjs";

/** Read-only program sent to the existing worker. No environment or credentials. */
export const PROBE_SOURCE = `
  const { get, Agent } = await import('node:http');
  const { readFile } = await import('node:fs/promises');
  const { createInterface } = await import('node:readline');
  const agent = new Agent({ keepAlive:true,maxSockets:1 });
  const output = value => process.stdout.write(JSON.stringify(value)+'\\n');
  let stopping=false, sequence=0;
  const memory = async id => {
    try {
      const [current, peak, limit, status] = await Promise.all([
        readFile('/sys/fs/cgroup/memory.current','utf8'), readFile('/sys/fs/cgroup/memory.peak','utf8'),
        readFile('/sys/fs/cgroup/memory.max','utf8'), readFile('/proc/1/status','utf8')]);
      output({kind:'memory',id,atEpochMs:Date.now(),cgroupCurrentBytes:Number(current),cgroupPeakBytes:Number(peak),
        cgroupLimitBytes:limit.trim()==='max'?null:Number(limit),pid1RssBytes:Number(/VmRSS:\\s+(\\d+)/.exec(status)?.[1]??0)*1024});
    } catch { output({kind:'memory',id,ok:false}); }
  };
  const health = () => new Promise(resolve => {
    let timer;
    const finish=value=>{clearTimeout(timer);resolve(value);};
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
  input.on('line',line=>{
    try { const command=JSON.parse(line);
      if(command.kind==='clock') output({kind:'clock',id:command.id,atEpochMs:Date.now()});
      if(command.kind==='memory') void memory(command.id);
      if(command.kind==='stop') stopping=true;
    } catch { stopping=true; }
  });
  input.on('close',()=>{stopping=true;});
  const deadline=setTimeout(()=>{stopping=true;},600000);
  output({kind:'ready'});
  let lastMemory=0;
  while(!stopping&&sequence<30000){
    const state=await health();
    output({kind:'health',sequence:++sequence,atEpochMs:Date.now(),monotonicMs:performance.now(),...state});
    if(Date.now()-lastMemory>=1000){lastMemory=Date.now();await memory();}
    await new Promise(resolve=>setTimeout(resolve,25));
  }
  clearTimeout(deadline);input.close();agent.destroy();
`;

export async function startProbe(binding, signal) {
  const identifier = binding.worker.id;
  assert.match(identifier, /^[a-f0-9]{64}$/);
  const child = spawn("docker", ["exec", "--interactive", identifier, "node", "--input-type=module", "--eval", PROBE_SOURCE],
    { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  const samples = [];
  const memory = [];
  const echoes = [];
  const pending = new Map();
  let ready = false;
  let failure;
  let ended = false;
  let closing;
  let nextId = 0;
  const lines = createInterface({ input: child.stdout });
  lines.on("line", (line) => {
    try {
      if (line.length > 4_096) throw fail("Worker probe response exceeded its budget");
      const value = JSON.parse(line);
      if (value.kind === "ready") ready = true;
      else if (value.kind === "health") {
        if (samples.length >= 30_000) throw fail("Worker probe sample budget exceeded");
        samples.push({ sequence: value.sequence, atEpochMs: value.atEpochMs, monotonicMs: value.monotonicMs,
          ok: value.ok === true && typeof value.running === "boolean" && Number.isInteger(value.waiting) &&
          value.waiting >= 0 && value.waiting <= 2 && Number.isSafeInteger(value.sequence) && Number.isFinite(value.atEpochMs) && Number.isFinite(value.monotonicMs),
          running: value.running, waiting: value.waiting, hostReceivedAt: Date.now() });
      } else if (value.kind === "memory") memory.push({ ...value, hostReceivedAt: Date.now() });
      const waiter = pending.get(value.id);
      if (waiter) { pending.delete(value.id); waiter(value); }
    } catch { failure = fail("Worker probe returned an invalid bounded record"); }
  });
  child.stderr.resume();
  child.stdin.on("error", () => { if (!closing) failure = fail("Worker probe control pipe failed"); });
  child.on("error", () => { failure = fail("Worker probe could not start"); });
  const exited = new Promise((resolve) => child.once("exit", (code) => { ended = true; if (code) failure = fail("Worker probe exited unsuccessfully"); resolve(); }));
  const check = () => { if (failure) throw failure; };
  const command = async (kind) => {
    check();
    if (ended) throw fail("Worker probe stopped before the run completed");
    const id = ++nextId;
    let result;
    pending.set(id, (value) => { result = value; });
    const sentAt = Date.now();
    child.stdin.write(`${JSON.stringify({ kind, id })}\n`);
    try { await waitFor(() => { check(); return result !== undefined; }, 5_000, signal); }
    finally { pending.delete(id); }
    return { value: result, sentAt, receivedAt: Date.now() };
  };
  const clock = async () => {
    for (let index = 0; index < 3; index += 1) {
      const result = await command("clock");
      echoes.push({ sentAt: result.sentAt, receivedAt: result.receivedAt, probeAt: result.value.atEpochMs });
    }
    return clockBounds(echoes);
  };
  const close = () => closing ??= (async () => {
    if (!ended) child.stdin.end(`${JSON.stringify({ kind: "stop" })}\n`);
    await Promise.race([exited, new Promise((resolve) => { const timer = setTimeout(resolve, 3_000); timer.unref(); })]);
    if (!ended) { child.kill(); throw fail("Worker probe stop could not be confirmed; stdin EOF and remote deadline bound its lifetime"); }
    lines.close();
    check();
  })();
  try {
    await waitFor(() => { check(); return ready; }, 10_000, signal);
    await clock();
    return { samples, memory, echoes, clock, close, check, container: identifier,
      sequence: () => samples.at(-1)?.sequence ?? 0,
      async waitState(running, after = 0) {
        await waitFor(() => { check(); return samples.some((entry) => entry.sequence > after && entry.ok && entry.running === running && entry.waiting === 0); }, 5_000, signal);
      },
      async memoryNow() { return (await command("memory")).value; },
    };
  } catch (error) { await close().catch(() => undefined); throw error; }
}
