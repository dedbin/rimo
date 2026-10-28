import type { Pool } from "pg";

// Trusted setup for tests whose subject is unrelated to email verification.
export async function verifyFixtureOwner(database: Pick<Pool, "query">, userId: string): Promise<void> {
  const result = await database.query(
    'UPDATE "user" SET "emailVerified"=true, "registrationPending"=false WHERE id=$1 AND "isAnonymous"=false',
    [userId],
  );
  if (result.rowCount !== 1) throw new Error("Expected one non-anonymous fixture owner");
}
