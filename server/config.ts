import path from "node:path";

export interface QuotaLimits {
  readonly maxOwners: number;
  readonly maxBoardsPerOwner: number;
  readonly maxBoardAssetBytes: number;
  readonly maxOwnerAssetBytes: number;
  readonly maxGlobalAssetBytes: number;
  readonly maxGlobalDocumentBytes: number;
}

export interface ServerConfig extends QuotaLimits {
  readonly databaseUrl: string;
  readonly authSecret: string;
  readonly authUrl: string;
  readonly trustedOrigins: readonly string[];
  readonly collaborationUrl: string;
  readonly uploadDir: string;
  readonly maxUploadBytes: number;
  readonly maxImagePixels: number;
}

export function getQuotaLimits(): QuotaLimits {
  return Object.freeze({
    maxOwners: positiveInteger("MAX_OWNERS", 6),
    maxBoardsPerOwner: positiveInteger("MAX_BOARDS_PER_OWNER", 20),
    maxBoardAssetBytes: positiveInteger("MAX_BOARD_ASSET_BYTES", 200 * 1024 * 1024),
    maxOwnerAssetBytes: positiveInteger("MAX_OWNER_ASSET_BYTES", 100 * 1024 * 1024),
    maxGlobalAssetBytes: positiveInteger("MAX_GLOBAL_ASSET_BYTES", 1024 * 1024 * 1024),
    maxGlobalDocumentBytes: positiveInteger("MAX_GLOBAL_DOCUMENT_BYTES", 500 * 1024 * 1024),
  });
}

function positiveInteger(name: string, fallback: number): number {
  const value = process.env[name];
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

export function getServerConfig(): ServerConfig {
  const databaseUrl = process.env.DATABASE_URL;
  const authSecret = process.env.BETTER_AUTH_SECRET;
  if (!databaseUrl) throw new Error("DATABASE_URL is required");
  if (!authSecret || authSecret.length < 32) {
    throw new Error("BETTER_AUTH_SECRET must contain at least 32 characters");
  }
  const authUrl = new URL(process.env.BETTER_AUTH_URL ?? "http://localhost:3000");
  if (!["http:", "https:"].includes(authUrl.protocol)) {
    throw new Error("BETTER_AUTH_URL must be an HTTP(S) URL");
  }
  const trustedOrigins = new Set([authUrl.origin]);
  for (const value of (process.env.TRUSTED_ORIGINS ?? "").split(",")) {
    if (!value.trim()) continue;
    const origin = new URL(value.trim());
    if (!["http:", "https:"].includes(origin.protocol)) {
      throw new Error("TRUSTED_ORIGINS must contain HTTP(S) origins");
    }
    trustedOrigins.add(origin.origin);
  }
  const collaborationUrl = new URL(authUrl.origin);
  collaborationUrl.protocol = authUrl.protocol === "https:" ? "wss:" : "ws:";
  if (["localhost", "127.0.0.1", "[::1]"].includes(authUrl.hostname)) {
    collaborationUrl.port = "1234";
  } else {
    collaborationUrl.pathname = "/collaboration";
  }
  // The session API supplies this value at runtime. Reflection also protects the
  // legacy public key from Next 15's post-minification NEXT_PUBLIC replacement.
  const environment = process.env;
  const legacyCollaborationUrl = Reflect.get(environment, "NEXT_PUBLIC_COLLABORATION_URL") as string | undefined;
  const configuredWebsocketUrl = new URL(
    environment.COLLABORATION_PUBLIC_URL ?? legacyCollaborationUrl ?? collaborationUrl.toString(),
  );
  if (!["ws:", "wss:"].includes(configuredWebsocketUrl.protocol)) {
    throw new Error("COLLABORATION_PUBLIC_URL must be a WebSocket URL");
  }
  if (configuredWebsocketUrl.username || configuredWebsocketUrl.password) {
    throw new Error("COLLABORATION_PUBLIC_URL must not contain credentials");
  }
  return Object.freeze({
    ...getQuotaLimits(),
    databaseUrl,
    authSecret,
    authUrl: authUrl.origin,
    trustedOrigins: Object.freeze([...trustedOrigins]),
    collaborationUrl: configuredWebsocketUrl.toString(),
    uploadDir: path.resolve(process.env.ASSET_STORAGE_PATH ?? "data/assets"),
    maxUploadBytes: positiveInteger("MAX_UPLOAD_BYTES", 10 * 1024 * 1024),
    maxImagePixels: positiveInteger("MAX_IMAGE_PIXELS", 20_000_000),
  });
}
