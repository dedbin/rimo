import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { main } from "./server-dashboard-bridge.mjs";

const temporaryRoot = fileURLToPath(new URL("../temp/", import.meta.url));
await mkdir(temporaryRoot, { recursive: true });
const root = await mkdtemp(path.join(temporaryRoot, "dashboard-bridge-check-"));
const operator = path.join(root, "data/operator");
const input = path.join(root, "message.json");
const helper = path.join(root, "scripts/server-ssh.py");
// Every credential and helper below is synthetic. No real config, SSH or process runs.
const marker = "SYNTHETIC_RESPONSE_SECRET_MUST_NOT_LEAK";
const unsafeText = "Прогресс; $(touch NEVER_EXECUTE)\n'\"<script>do not execute</script>";
const payload = { title: "Проверка", message: unsafeText, tags: ["white_check_mark"] };
let mode = "normal";
const calls = [];
const uploaded = new Map();
const remoteNames = new Set();
let releaseUploads;
let uploadBarrier;
let waitingUploads = 0;
let passed = 0;
const execute = async (binary, args, options) => {
  assert.equal(binary, process.execPath); assert.equal(args[0], helper);
  assert.equal(options.timeout, 45_000); assert.equal(options.maxBuffer, 1_048_576);
  assert.ok(options.signal instanceof AbortSignal); assert.equal(options.windowsHide, true);
  assert.ok(!args.join(" ").includes(unsafeText) && !args.join(" ").includes(marker));
  calls.push({ args, signal: options.signal });
  if (args[1] === "upload") {
    assert.match(args[3], /^\/srv\/rimo\/private\/bridge-progress-[a-f0-9-]{36}\.json$/);
    remoteNames.add(args[3]);
    assert.equal(path.dirname(args[2]), path.join(operator, "tmp"));
    const data = JSON.parse(await readFile(args[2], "utf8"));
    uploaded.set(args[3], data);
    if (mode === "concurrent") {
      waitingUploads++;
      if (waitingUploads === 2) releaseUploads();
      await uploadBarrier;
    } else assert.deepEqual(data, payload);
    if (["failure", "cleanup-failure"].includes(mode)) throw new Error(`${marker} ${unsafeText}`);
    return JSON.stringify({ event: "upload", status: "complete", token: marker });
  }
  assert.equal(args[1], "run");
  const script = await readFile(args[2], "utf8");
  assert.equal(path.dirname(args[2]), path.join(operator, "tmp"));
  assert.ok(!script.includes(unsafeText) && !script.includes(marker));
  assert.match(path.basename(args[2]), /^[a-f0-9-]{36}\.sh$/);
  const cleanup = /^set -eu\nrm -f -- (\/srv\/rimo\/private\/bridge-progress-[a-f0-9-]{36}\.json)\n$/.exec(script);
  if (cleanup) {
    if (mode === "cleanup-failure") throw new Error(marker);
    uploaded.delete(cleanup[1]);
    return "";
  }
  if (mode === "malformed") return `${marker}: not JSON`;
  if (script.endsWith(" poll\n")) {
    assert.equal(script, "set -eu\nnode /srv/rimo/current/scripts/server-dashboard.mjs poll\n");
    return JSON.stringify({ status: "read", since: "all", token: marker, messages: [{ id: "message1", time: 1, title: "Входящее", message: unsafeText, token: marker, actions: ["do-not-execute"] }] });
  }
  if (script.endsWith(" ack --id message1\n")) {
    return JSON.stringify({ status: "acknowledged", id: mode === "wrong-id" ? "different1" : "message1", token: marker });
  }
  const remoteFile = /publish --input-file ([^\n]+)\n/.exec(script)?.[1];
  assert.ok(remoteFile && remoteNames.has(remoteFile));
  assert.equal(script, `set -eu\ntrap 'rm -f -- ${remoteFile}' EXIT\nnode /srv/rimo/current/scripts/server-dashboard.mjs publish --input-file ${remoteFile}\nrm -f -- ${remoteFile}\n`);
  const data = uploaded.get(remoteFile);
  uploaded.delete(remoteFile);
  return JSON.stringify({ status: "published", id: mode === "concurrent" ? `pub_${data.title}` : "published1", token: marker });
};

async function invoke(args) {
  let output = "";
  const write = process.stdout.write;
  process.stdout.write = (chunk) => { output += chunk; return true; };
  try { await main(args, { root, execute }); return JSON.parse(output); }
  finally { process.stdout.write = write; assert.ok(!output.includes(marker)); }
}

async function rejected(args, code) {
  await assert.rejects(() => invoke(args), (error) => {
    assert.equal(error.message, code); assert.ok(!String(error.stack).includes(marker)); return true;
  });
}

try {
  await mkdir(operator, { recursive: true }); await mkdir(path.dirname(helper));
  await writeFile(helper, "# Synthetic helper. Never executed.\n");
  await writeFile(path.join(operator, "runtime.json"), JSON.stringify({ python: process.execPath }));
  await writeFile(path.join(operator, "known_hosts"), "# Synthetic test pin, no real host\n");
  await writeFile(input, `\uFEFF${JSON.stringify(payload)}`);
  const polled = await invoke(["poll"]);
  assert.deepEqual(Object.keys(polled), ["status", "since", "messages"]);
  assert.deepEqual(Object.keys(polled.messages[0]), ["id", "time", "title", "message"]);
  assert.equal(polled.messages[0].message, unsafeText); passed++;
  assert.deepEqual(await invoke(["ack", "--id", "message1"]), { status: "acknowledged", id: "message1" }); passed++;
  const count = calls.length;
  assert.deepEqual(await invoke(["publish", "--input-file", input]), { status: "published", id: "published1" });
  assert.equal(calls.length, count + 2); assert.equal(calls.at(-1).signal, calls.at(-2).signal); passed++;
  assert.deepEqual(await readdir(path.join(operator, "tmp")), []); passed++;
  await rejected(["ack", "--id", "bad; touch pwned"], "MESSAGE_ID_INVALID"); passed++;
  await rejected(["poll", "--id", "message1"], "OPTIONS_INVALID"); passed++;
  mode = "wrong-id"; await rejected(["ack", "--id", "message1"], "REMOTE_RESPONSE_INVALID"); passed++;
  mode = "malformed"; await rejected(["poll"], "REMOTE_RESPONSE_INVALID"); passed++;
  mode = "failure"; await rejected(["publish", "--input-file", input], "DASHBOARD_BRIDGE_FAILED");
  assert.deepEqual(await readdir(path.join(operator, "tmp")), []); assert.equal(uploaded.size, 0); passed++;
  mode = "cleanup-failure"; await rejected(["publish", "--input-file", input], "REMOTE_PROGRESS_CLEANUP_UNCONFIRMED");
  assert.deepEqual(await readdir(path.join(operator, "tmp")), []); uploaded.clear(); passed++;
  mode = "concurrent"; uploadBarrier = new Promise((resolve) => { releaseUploads = resolve; });
  const firstInput = path.join(root, "first.json"); const secondInput = path.join(root, "second.json");
  await writeFile(firstInput, JSON.stringify({ ...payload, title: "A", message: `A ${unsafeText}` }));
  await writeFile(secondInput, JSON.stringify({ ...payload, title: "B", message: `B ${unsafeText}` }));
  let concurrentOutput = ""; const originalWrite = process.stdout.write;
  let concurrentDeadline;
  const concurrentTasks = [];
  process.stdout.write = (chunk) => { concurrentOutput += chunk; return true; };
  try {
    concurrentTasks.push(main(["publish", "--input-file", firstInput], { root, execute }), main(["publish", "--input-file", secondInput], { root, execute }));
    await Promise.race([
      Promise.all(concurrentTasks),
      new Promise((_, reject) => { concurrentDeadline = setTimeout(() => reject(new Error("CONCURRENT_CHECK_TIMED_OUT")), 10_000); }),
    ]);
  } finally {
    releaseUploads();
    await Promise.allSettled(concurrentTasks);
    clearTimeout(concurrentDeadline); process.stdout.write = originalWrite;
  }
  assert.deepEqual(concurrentOutput.trim().split("\n").map((line) => JSON.parse(line).id).sort(), ["pub_A", "pub_B"]);
  assert.ok(!concurrentOutput.includes(marker)); assert.equal(uploaded.size, 0); passed++;
  mode = "normal";
  await writeFile(input, JSON.stringify({ message: "valid", topic: "rimo-inbox" }));
  await rejected(["publish", "--input-file", input], "PUBLISH_INPUT_INVALID"); passed++;
  await writeFile(input, "x".repeat(8193));
  await rejected(["publish", "--input-file", input], "INPUT_TOO_LARGE_OR_INVALID"); passed++;
  await writeFile(path.join(operator, "runtime.json"), JSON.stringify({ python: "relative-python" }));
  await rejected(["poll"], "PYTHON_RUNTIME_INVALID"); passed++;
  assert.deepEqual(await readdir(path.join(operator, "tmp")), []); passed++;
} finally {
  const resolved = await realpath(root);
  assert.equal(path.dirname(resolved), await realpath(temporaryRoot));
  assert.ok(path.basename(resolved).startsWith("dashboard-bridge-check-"));
  await rm(resolved, { recursive: true });
}
process.stdout.write(`${JSON.stringify({ passed, realSshCalls: 0, realCredentialsRead: false, temporaryFilesRemoved: true })}\n`);
