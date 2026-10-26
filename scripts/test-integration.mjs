import { spawn } from "node:child_process";

const databaseUrl = process.env.RIMO_TEST_DATABASE_URL ?? process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("Set RIMO_TEST_DATABASE_URL to an isolated PostgreSQL test database");
const child = spawn(process.execPath, ["node_modules/vitest/vitest.mjs", "run", ...process.argv.slice(2)], {
  stdio: "inherit",
  env: { ...process.env, DATABASE_URL: databaseUrl, RIMO_TEST_DATABASE_URL: databaseUrl },
});
child.on("error", () => { process.exitCode = 1; });
child.on("exit", (code) => { process.exitCode = code ?? 1; });
