import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";
import { loadEnvFile } from "node:process";

import { defineConfig, devices } from "@playwright/test";
import { prepareTestMail } from "./e2e/mail-config";

if (!process.env.RIMO_E2E_BASE_URL && existsSync(".env.local")) loadEnvFile(".env.local");
process.env.RIMO_E2E_RUN_ID ??= randomUUID();
if (!/^[a-f0-9-]{36}$/.test(process.env.RIMO_E2E_RUN_ID)) throw new Error("Invalid internal E2E run ID");
const runId = process.env.RIMO_E2E_RUN_ID;
const external = process.env.RIMO_E2E_BASE_URL;
const mailEnvironment = external || process.argv.includes("--list") ? {} : prepareTestMail(runId);
const baseURL = external ?? "http://localhost:3000";
const authState = process.env.RIMO_E2E_STORAGE_STATE
  ? path.resolve(process.env.RIMO_E2E_STORAGE_STATE)
  : path.resolve("temp/e2e", `owner-${process.env.RIMO_E2E_RUN_ID}.json`);
const localEnvironment = { ...mailEnvironment, BETTER_AUTH_URL: baseURL, COLLABORATION_PUBLIC_URL: "ws://localhost:1234",
  PDF_WORKER_URL: "http://localhost:3100", PORT: "3000", HOSTNAME: "127.0.0.1", COLLABORATION_HOST: "127.0.0.1", COLLABORATION_PORT: "1234" };

export default defineConfig({
  testDir: "./e2e",
  testMatch: "**/*.spec.ts",
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: 0,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  outputDir: path.resolve("test-results/e2e", runId),
  reporter: process.env.CI ? [["line"], ["html", { open: "never", outputFolder: path.resolve("playwright-report", runId) }]] : "list",
  globalSetup: "./e2e/auth.setup.ts",
  globalTeardown: "./e2e/auth.teardown.ts",
  metadata: { authState, external: !!external, runId },
  use: {
    ...devices["Desktop Chrome"],
    baseURL, storageState: authState, locale: "ru-RU", viewport: { width: 1440, height: 1000 },
    permissions: ["clipboard-read", "clipboard-write"],
    headless: true,
    launchOptions: { channel: process.env.RIMO_E2E_BROWSER_CHANNEL },
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  webServer: external ? undefined : [
    { command: "node e2e/mail-server.mjs", url: "http://127.0.0.1:1080/health", timeout: 30_000, reuseExistingServer: false, env: mailEnvironment },
    { command: process.env.RIMO_E2E_APP_COMMAND ?? "npm start", url: `${baseURL}/api/health`, timeout: 120_000, reuseExistingServer: false, env: localEnvironment },
    { command: "node --enable-source-maps --env-file-if-exists=.env.local dist/collaboration/index.mjs", url: "http://localhost:1234/healthz", timeout: 30_000, reuseExistingServer: !process.env.CI, env: localEnvironment },
    { command: "node --env-file-if-exists=.env.local e2e/start-worker.mjs", url: "http://localhost:3100/healthz", timeout: 30_000, reuseExistingServer: !process.env.CI },
  ],
});
