import { spawn } from "node:child_process";

// The local PDF worker receives no database or Better Auth configuration.
const allowed = ["PATH", "Path", "SystemRoot", "SYSTEMROOT", "COMSPEC", "TEMP", "TMP", "HOME", "USERPROFILE", "LOCALAPPDATA", "LANG",
  "PLAYWRIGHT_BROWSERS_PATH", "PDF_WORKER_TOKEN", "PDF_WORKER_BROWSER_CHANNEL", "PDF_CHROMIUM_SANDBOX"];
const environment = Object.fromEntries(allowed.flatMap((key) => process.env[key] === undefined ? [] : [[key, process.env[key]]]));
const child = spawn(process.execPath, ["--import=tsx", "export-worker/index.ts"], {
  env: { ...environment, NODE_ENV: "production", PDF_WORKER_HOST: "127.0.0.1", PDF_WORKER_PORT: "3100" },
  stdio: "inherit", shell: false, windowsHide: true,
});
for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => child.kill(signal));
child.once("error", () => { process.stderr.write("Could not start the E2E PDF worker.\n"); process.exitCode = 1; });
child.once("exit", (code) => { process.exitCode = code ?? 1; });
