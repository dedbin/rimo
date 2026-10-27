import { rm } from "node:fs/promises";
import path from "node:path";

import type { FullConfig } from "@playwright/test";

export default async function cleanupAuthentication(config: FullConfig): Promise<void> {
  if (process.env.RIMO_E2E_STORAGE_STATE) return;
  const filename = path.resolve(String(config.metadata.authState));
  if (path.dirname(filename) !== path.resolve("temp/e2e") || !/^owner-[a-f0-9-]+\.json$/.test(path.basename(filename))) {
    throw new Error("Unexpected E2E authentication state path");
  }
  await rm(filename, { force: true });
}
