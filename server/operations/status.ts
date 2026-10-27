import type { Pool } from "pg";

import { storageSpaceHealth } from "../../lib/storage-space.mjs";
import type { QuotaLimits } from "../config";
import { inspectStorage, OperationsError, safeNumber } from "./storage";
import type { StorageMetrics } from "./storage";

export { storageSpaceHealth };

export type ServiceHealth = "healthy" | "warning" | "critical";
export interface ServiceUsage {
  readonly owners: number; readonly boards: number; readonly documents: number; readonly documentBytes: number;
  readonly assets: number; readonly assetBytes: number;
  readonly maxBoardsPerOwner: number; readonly maxOwnerAssetBytes: number; readonly maxBoardAssetBytes: number;
}
export interface ServiceStatus {
  readonly version: 1; readonly checkedAt: string; readonly status: ServiceHealth; readonly reasonCodes: readonly string[];
  readonly database: { readonly reachable: boolean }; readonly usage: ServiceUsage | null;
  readonly quotas: QuotaLimits; readonly storage: StorageMetrics | null;
}

async function databaseUsage(database: Pool): Promise<ServiceUsage> {
  const result = await database.query<Record<keyof ServiceUsage, string>>(`SELECT
    (SELECT count(*) FROM "user" WHERE "isAnonymous" = false) AS owners,
    (SELECT count(*) FROM boards) AS boards,
    (SELECT count(*) FROM board_documents) AS documents,
    (SELECT COALESCE(sum(octet_length(state)),0) FROM board_documents) AS "documentBytes",
    (SELECT count(*) FROM assets) AS assets,
    (SELECT COALESCE(sum(byte_size),0) FROM assets) AS "assetBytes",
    (SELECT COALESCE(max(n),0) FROM (SELECT count(*) AS n FROM boards GROUP BY owner_id) usage) AS "maxBoardsPerOwner",
    (SELECT COALESCE(max(n),0) FROM (SELECT sum(a.byte_size) AS n FROM assets a JOIN boards b ON b.id=a.board_id GROUP BY b.owner_id) usage) AS "maxOwnerAssetBytes",
    (SELECT COALESCE(max(n),0) FROM (SELECT sum(byte_size) AS n FROM assets GROUP BY board_id) usage) AS "maxBoardAssetBytes"`);
  const row = result.rows[0];
  return { owners: safeNumber(row.owners), boards: safeNumber(row.boards), documents: safeNumber(row.documents),
    documentBytes: safeNumber(row.documentBytes), assets: safeNumber(row.assets), assetBytes: safeNumber(row.assetBytes),
    maxBoardsPerOwner: safeNumber(row.maxBoardsPerOwner), maxOwnerAssetBytes: safeNumber(row.maxOwnerAssetBytes), maxBoardAssetBytes: safeNumber(row.maxBoardAssetBytes) };
}

export async function collectServiceStatus(options: {
  readonly database: Pool; readonly uploadDir: string; readonly quotas: QuotaLimits;
}): Promise<ServiceStatus> {
  const checkedAt = new Date().toISOString();
  const checks = await Promise.allSettled([databaseUsage(options.database), inspectStorage(options.uploadDir)]);
  const usage = checks[0].status === "fulfilled" ? checks[0].value : null;
  const storage = checks[1].status === "fulfilled" ? checks[1].value : null;
  const reasons: string[] = [];
  let status: ServiceHealth = "healthy";
  const flag = (code: string, severity: "warning" | "critical"): void => {
    reasons.push(code); if (severity === "critical" || status === "healthy") status = severity;
  };
  if (!usage) flag("DATABASE_CHECK_FAILED", "critical");
  if (!storage) flag(checks[1].status === "rejected" && checks[1].reason instanceof OperationsError
    ? checks[1].reason.code : "STORAGE_CHECK_FAILED", "critical");
  if (storage) {
    if (!storage.readable || !storage.writable) flag("STORAGE_ACCESS_FAILED", "critical");
    const space = storageSpaceHealth(storage.freeBytes, storage.totalBytes);
    if (space === "critical") flag("STORAGE_SPACE_CRITICAL", "critical");
    else if (space === "low") flag("STORAGE_SPACE_LOW", "warning");
  }
  if (usage) {
    const resources = [
      ["OWNERS", usage.owners, options.quotas.maxOwners],
      ["BOARDS_PER_OWNER", usage.maxBoardsPerOwner, options.quotas.maxBoardsPerOwner],
      ["BOARD_ASSETS", usage.maxBoardAssetBytes, options.quotas.maxBoardAssetBytes],
      ["OWNER_ASSETS", usage.maxOwnerAssetBytes, options.quotas.maxOwnerAssetBytes],
      ["GLOBAL_ASSETS", usage.assetBytes, options.quotas.maxGlobalAssetBytes],
      ["GLOBAL_DOCUMENTS", usage.documentBytes, options.quotas.maxGlobalDocumentBytes],
    ] as const;
    for (const [code, used, limit] of resources) {
      if (used >= limit) flag(`${code}_LIMIT_REACHED`, code === "GLOBAL_DOCUMENTS" ? "critical" : "warning");
      else if (used >= limit * 0.8) flag(`${code}_LIMIT_NEAR`, "warning");
    }
  }
  return { version: 1, checkedAt, status, reasonCodes: reasons, database: { reachable: usage !== null }, usage,
    quotas: { ...options.quotas }, storage };
}

export function serviceStatusExitCode(status: ServiceHealth): number { return status === "healthy" ? 0 : status === "warning" ? 1 : 2; }
