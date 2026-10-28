import { spawnSync } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

async function checkDirectory(directory) {
  let checked = 0;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) { checked += await checkDirectory(filename); continue; }
    if (!entry.name.endsWith(".sh")) continue;
    const content = await readFile(filename, "utf8");
    if (content.includes("\r")) throw new Error(`${filename}: shell scripts require LF line endings`);
    const executable = process.env.RIMO_BASH ?? "bash";
    const result = spawnSync(executable, ["-n", filename], { encoding: "utf8", windowsHide: true });
    if (result.error || result.status !== 0) throw new Error(`${filename}: shell syntax check failed`);
    checked += 1;
  }
  return checked;
}

const checked = await checkDirectory("deploy");
process.stdout.write(`Deployment shell scripts verified: ${checked}\n`);
