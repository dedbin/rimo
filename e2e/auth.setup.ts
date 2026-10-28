import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { chromium, expect } from "@playwright/test";
import type { FullConfig } from "@playwright/test";

export default async function authenticate(config: FullConfig): Promise<void> {
  const project = config.projects[0];
  const state = String(config.metadata.authState);
  const existing = process.env.RIMO_E2E_STORAGE_STATE;
  if (!existing && (!process.env.RIMO_E2E_EMAIL || !process.env.RIMO_E2E_PASSWORD)) {
    throw new Error("E2E requires a provisioned owner: RIMO_E2E_EMAIL/PASSWORD or RIMO_E2E_STORAGE_STATE.");
  }
  const browser = await chromium.launch({ headless: true, ...project.use.launchOptions });
  const context = await browser.newContext({ baseURL: project.use.baseURL, locale: "ru-RU", ...(existing ? { storageState: state } : {}) });
  let phase = "navigation";
  try {
    const page = await context.newPage();
    await page.goto("/", { waitUntil: "domcontentloaded" });
    if (!existing) {
      phase = "open-dialog";
      await page.getByRole("button", { name: "Войти", exact: true }).first().click();
      phase = "fill-credentials";
      await page.getByLabel("Почта", { exact: true }).fill(process.env.RIMO_E2E_EMAIL!);
      await page.getByLabel("Пароль", { exact: true }).fill(process.env.RIMO_E2E_PASSWORD!);
      phase = "submit-login";
      await page.getByRole("dialog").getByRole("button", { name: "Войти", exact: true }).click();
    }
    phase = "owner-interface";
    await expect(page.getByRole("button", { name: "Создать доску", exact: true }).first()).toBeVisible();
    if (!existing) {
      phase = "save-state";
      await mkdir(path.dirname(state), { recursive: true });
      await writeFile(state, JSON.stringify(await context.storageState()), { flag: "wx", mode: 0o600 });
    }
  } catch {
    // Keep passwords, cookies and sign-in request bodies out of setup errors/traces.
    throw new Error(`E2E owner login failed at ${phase}. Check the base URL, provisioned credentials or local storage state.`);
  } finally { await context.close(); await browser.close(); }
}
