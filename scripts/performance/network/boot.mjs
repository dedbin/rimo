import { execFileSync, spawn } from "node:child_process";

const tc = (args) => execFileSync("tc", args, { stdio: "inherit" });
// Both classes aggregate all TCP connections for one browser. The listen port
// distinguishes traffic toward the browser from the onward server connection.
tc(["qdisc", "replace", "dev", "eth0", "root", "handle", "1:", "htb", "default", "20"]);
for (const id of ["10", "20"]) {
  tc(["class", "add", "dev", "eth0", "parent", "1:", "classid", `1:${id}`, "htb", "rate", "50mbit", "ceil", "50mbit", "burst", "64k", "cburst", "64k", "quantum", "1514"]);
}
tc(["filter", "add", "dev", "eth0", "protocol", "ip", "parent", "1:", "prio", "1", "u32", "match", "ip", "sport", "8666", "0xffff", "flowid", "1:10"]);

const children = [
  spawn("tinyproxy", ["-d", "-c", "/probe/tinyproxy.conf"], { stdio: "inherit" }),
  spawn("toxiproxy", ["-host=0.0.0.0"], { stdio: "inherit" }),
];
let stopping = false;
const stop = () => {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill("SIGTERM");
};
for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, stop);
for (const child of children) {
  child.once("error", () => { process.exitCode = 1; stop(); });
  child.once("exit", (code) => { if (!stopping) { process.exitCode = code ?? 1; stop(); } });
}
