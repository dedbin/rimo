import path from "node:path";

export interface ServerConfig {
  readonly databaseUrl: string;
  readonly authSecret: string;
  readonly authUrl: string;
  readonly trustedOrigins: readonly string[];
  readonly collaborationUrl: string;
  readonly uploadDir: string;
  readonly maxUploadBytes: number;
  readonly maxBoardAssetBytes: number;
  readonly maxImagePixels: number;
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
  const configuredWebsocketUrl = new URL(
    process.env.NEXT_PUBLIC_COLLABORATION_URL ?? collaborationUrl.toString(),
  );
  if (!["ws:", "wss:"].includes(configuredWebsocketUrl.protocol)) {
    throw new Error("NEXT_PUBLIC_COLLABORATION_URL must be a WebSocket URL");
  }
  return Object.freeze({
    databaseUrl,
    authSecret,
    authUrl: authUrl.origin,
    trustedOrigins: Object.freeze([...trustedOrigins]),
    collaborationUrl: configuredWebsocketUrl.toString(),
    uploadDir: path.resolve(process.env.ASSET_STORAGE_PATH ?? "data/assets"),
    maxUploadBytes: positiveInteger("MAX_UPLOAD_BYTES", 10 * 1024 * 1024),
    maxBoardAssetBytes: positiveInteger("MAX_BOARD_ASSET_BYTES", 200 * 1024 * 1024),
    maxImagePixels: positiveInteger("MAX_IMAGE_PIXELS", 20_000_000),
  });
}
