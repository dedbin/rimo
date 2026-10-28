import { getPool } from "../server/db";
import { runMigrations } from "../server/migrations";
import { loadEnvironment } from "./load-env";

async function main(): Promise<void> {
  loadEnvironment();
  try {
    const applied = await runMigrations();
    process.stdout.write(applied.length ? `Applied: ${applied.join(", ")}\n` : "Database schema is current.\n");
  } finally {
    await getPool().end();
  }
}

main().catch((error: unknown) => {
  console.error("Migration failed", error instanceof Error ? error.message : "Unknown error");
  process.exitCode = 1;
});
