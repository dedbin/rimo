import { spawn } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";

/** @param {NodeJS.ProcessEnv} environment */
export function integrationTestEnvironment(environment) {
  const databaseUrl = environment.RIMO_TEST_DATABASE_URL;
  if (typeof databaseUrl !== "string" || !databaseUrl.trim()) {
    throw new Error("Set RIMO_TEST_DATABASE_URL to a dedicated PostgreSQL test database");
  }
  return { ...environment, DATABASE_URL: databaseUrl, RIMO_TEST_DATABASE_URL: databaseUrl };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const child = spawn(process.execPath, ["node_modules/vitest/vitest.mjs", "run", ...process.argv.slice(2)], {
    stdio: "inherit",
    env: integrationTestEnvironment(process.env),
  });
  child.on("error", () => { process.exitCode = 1; });
  child.on("exit", (code) => { process.exitCode = code ?? 1; });
}
