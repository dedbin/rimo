import { Pool } from "pg";

import { createPostgresRepository } from "../../postgres-repository";
import { createCollaborationServer } from "../../server";

async function main(): Promise<void> {
  const schema = process.env.RIMO_WS_TEST_SCHEMA ?? "";
  if (!/^rimo_ws_test_[a-f0-9]{32}$/.test(schema)) throw new Error("Invalid test schema");
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    options: `-c search_path=${schema}`,
    max: 2,
  });
  const server = createCollaborationServer({
    origins: ["http://localhost:3000"], port: 0,
    limits: { persistenceDebounceMs: 20, persistenceMaxDebounceMs: 50 },
  }, {
    repository: createPostgresRepository(pool),
    async authenticate(headers, boardId) {
      if (headers.get("cookie") !== "rimo-test=editor") return null;
      return { boardId, userId: "editor", sessionId: "test-session", name: "Editor", role: "editor" };
    },
    async revalidate() { return "editor"; },
  });
  await server.listen();
  process.send?.({ type: "ready", port: server.address.port });
  process.on("message", (message: unknown) => {
    if (typeof message !== "object" || message === null || !("type" in message) || message.type !== "stop") return;
    void server.destroy().then(() => pool.end()).then(() => process.exit(0)).catch(() => process.exit(1));
  });
}

main().catch(() => {
  process.send?.({ type: "failed" });
  process.exit(1);
});
