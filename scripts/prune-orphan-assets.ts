import type { Pool } from "pg";

import { getServerConfig } from "../server/config";
import { getPool } from "../server/db";
import { pruneOrphanAssets } from "../server/operations/prune";
import { loadEnvironment } from "./load-env";

async function main(): Promise<void> {
  let database: Pool | undefined;
  try {
    loadEnvironment();
    const args = process.argv.slice(2);
    if (args.length > 1 || args.some((argument) => argument !== "--apply")) {
      process.stdout.write(`${JSON.stringify({ version: 1, status: "aborted", reasonCodes: ["INVALID_ARGUMENTS"], usage: "node --import=tsx scripts/prune-orphan-assets.ts [--apply]" })}\n`);
      process.exitCode = 2;
      return;
    }
    const config = getServerConfig();
    database = getPool();
    const report = await pruneOrphanAssets({ database, uploadDir: config.uploadDir, apply: args.includes("--apply") });
    process.stdout.write(`${JSON.stringify(report)}\n`);
    process.exitCode = report.status === "completed" ? 0 : 2;
  } catch {
    process.stdout.write(`${JSON.stringify({ version: 1, status: "aborted", reasonCodes: ["CONFIGURATION_OR_PRUNE_FAILED"], removedCount: 0 })}\n`);
    process.exitCode = 2;
  } finally { if (database) await database.end(); }
}
void main().catch(() => { process.exitCode = 2; });
