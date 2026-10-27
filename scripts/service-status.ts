import type { Pool } from "pg";

import { getQuotaLimits, getServerConfig } from "../server/config";
import { getPool } from "../server/db";
import { collectServiceStatus, serviceStatusExitCode } from "../server/operations/status";
import { loadEnvironment } from "./load-env";

async function main(): Promise<void> {
  let database: Pool | undefined;
  try {
    loadEnvironment();
    if (process.argv.length > 2) throw new Error("Unexpected argument");
    const config = getServerConfig();
    database = getPool();
    const report = await collectServiceStatus({ database, uploadDir: config.uploadDir, quotas: getQuotaLimits() });
    process.stdout.write(`${JSON.stringify(report)}\n`);
    process.exitCode = serviceStatusExitCode(report.status);
  } catch {
    process.stdout.write(`${JSON.stringify({ version: 1, checkedAt: new Date().toISOString(), status: "critical", reasonCodes: ["CONFIGURATION_OR_STATUS_FAILED"] })}\n`);
    process.exitCode = 2;
  } finally { if (database) await database.end(); }
}
void main().catch(() => { process.exitCode = 2; });
