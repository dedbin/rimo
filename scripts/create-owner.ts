import { createOwnerAccount } from "../server/auth";
import { getPool } from "../server/db";
import { loadEnvironment } from "./load-env";

async function main(): Promise<void> {
  loadEnvironment();
  const email = process.env.OWNER_EMAIL?.trim().toLowerCase();
  const password = process.env.OWNER_PASSWORD;
  const name = process.env.OWNER_NAME?.trim() || "Владелец";
  if (!email || !password) {
    throw new Error("Set OWNER_EMAIL and OWNER_PASSWORD (at least 12 characters) in the environment.");
  }
  if (name.length > 80) throw new Error("OWNER_NAME must contain at most 80 characters.");
  try {
    const result = await createOwnerAccount({ email, password, name });
    process.stdout.write(`Owner account created: ${result.user.id}\n`);
  } finally {
    await getPool().end();
  }
}

main().catch((error: unknown) => {
  console.error("Owner creation failed", error instanceof Error ? error.message : "Unknown error");
  process.exitCode = 1;
});
