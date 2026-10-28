import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type { BrowserServer } from "playwright";

const execute = promisify(execFile);

export async function terminateBrowser(server: BrowserServer): Promise<void> {
  if (process.platform !== "win32") { await server.kill(); return; }
  const child = server.process();
  if (!child.pid || child.exitCode !== null) return;
  // Avoid shell expansion; the PID belongs only to this job's Chromium child.
  try { await execute("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, timeout: 2_000 }); }
  catch { child.kill("SIGKILL"); }
}

export async function closeBrowser(server: BrowserServer): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const force = new Promise<void>((resolve) => {
    timer = setTimeout(() => { void terminateBrowser(server).catch(() => undefined).finally(resolve); }, 1_000);
  });
  try { await Promise.race([server.close().catch(() => undefined), force]); }
  finally { if (timer) clearTimeout(timer); }
}
