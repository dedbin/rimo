import { getServerConfig } from "../server/config";
import { getPool } from "../server/db";

import { createCollaborationDependencies } from "./dependencies";
import { createCollaborationServer } from "./server";
import { acquireWriterLock, WriterAlreadyRunningError } from "./writer-lock";

function portFromEnvironment(): number {
  const port = Number(process.env.COLLABORATION_PORT ?? 1234);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error("COLLABORATION_PORT must be a valid port");
  }
  return port;
}

async function main(): Promise<void> {
  const config = getServerConfig();
  const port = portFromEnvironment();
  const pool = getPool();
  let releaseWriter: () => Promise<void>;
  try {
    releaseWriter = await acquireWriterLock(pool, () => {
      console.error(JSON.stringify({ event: "collaboration_writer_lock_lost" }));
      process.exit(1);
    });
  } catch (error) {
    await pool.end();
    throw error;
  }
  const server = createCollaborationServer({
    origins: config.trustedOrigins,
    address: process.env.COLLABORATION_HOST ?? "127.0.0.1",
    port,
  }, createCollaborationDependencies());
  try {
    await server.listen();
  } catch (error) {
    await releaseWriter();
    await pool.end();
    throw error;
  }
  console.info(JSON.stringify({ event: "collaboration_started", port: server.address.port }));

  let stopping = false;
  const shutdown = async (): Promise<void> => {
    if (stopping) return;
    stopping = true;
    const deadline = setTimeout(() => {
      console.error(JSON.stringify({ event: "collaboration_shutdown_timeout" }));
      process.exit(1);
    }, 15_000);
    deadline.unref();
    try {
      await server.destroy();
      await releaseWriter();
      await pool.end();
      clearTimeout(deadline);
    } catch {
      console.error(JSON.stringify({ event: "collaboration_shutdown_failed" }));
      process.exitCode = 1;
    }
  };
  process.once("SIGTERM", () => { void shutdown(); });
  process.once("SIGINT", () => { void shutdown(); });
}

main().catch((error: unknown) => {
  console.error(JSON.stringify(error instanceof WriterAlreadyRunningError
    ? { event: "collaboration_writer_already_running", message: error.message }
    : { event: "collaboration_start_failed" }));
  process.exit(1);
});
