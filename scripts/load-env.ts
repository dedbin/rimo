import { existsSync } from "node:fs";
import { loadEnvFile } from "node:process";

export function loadEnvironment(): void {
  if (existsSync(".env.local")) loadEnvFile(".env.local");
  if (existsSync(".env")) loadEnvFile(".env");
}
