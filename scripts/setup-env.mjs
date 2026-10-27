import { randomBytes } from "node:crypto";
import { existsSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const origin = new URL(process.argv[2] ?? "http://localhost:3080");
if (!["http:", "https:"].includes(origin.protocol) || origin.username || origin.password) {
  throw new Error("Provide an HTTP(S) origin, for example https://board.example.com");
}
if (origin.pathname !== "/" || origin.search || origin.hash) {
  throw new Error("Use an origin without a path, query, or fragment");
}
const target = resolve(".env");
if (existsSync(target)) throw new Error(".env already exists; it was not overwritten");
const databasePassword = randomBytes(32).toString("base64url");
const websocket = new URL("/collaboration", origin);
websocket.protocol = origin.protocol === "https:" ? "wss:" : "ws:";
writeFileSync(target, [
  `POSTGRES_PASSWORD=${databasePassword}`,
  `DATABASE_URL=postgresql://rimo:${databasePassword}@db:5432/rimo`,
  `BETTER_AUTH_SECRET=${randomBytes(48).toString("base64url")}`,
  `PDF_WORKER_TOKEN=${randomBytes(48).toString("base64url")}`,
  `BETTER_AUTH_URL=${origin.origin}`,
  `COLLABORATION_PUBLIC_URL=${websocket.href}`,
  `APP_DOMAIN=${origin.protocol === "http:" ? "http://" : ""}${origin.hostname}`,
  `HTTP_PORT=${origin.protocol === "http:" ? origin.port || 80 : 80}`,
  `HTTPS_PORT=${origin.protocol === "https:" ? origin.port || 443 : 443}`,
  "MAX_BOARD_ASSET_BYTES=104857600",
  "",
].join("\n"), { mode: 0o600, flag: "wx" });
process.stdout.write("Created .env with independent random secrets. Do not commit this file.\n");
