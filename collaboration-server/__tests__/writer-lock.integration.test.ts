// @vitest-environment node
import { fork } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:net";
import path from "node:path";

import { escapeIdentifier, Pool } from "pg";
import { describe, expect, it } from "vitest";

import { acquireWriterLock, WriterAlreadyRunningError } from "../writer-lock";

async function freePort(): Promise<number> {
  const socket = createServer();
  await new Promise<void>((resolve) => socket.listen(0, "127.0.0.1", resolve));
  const address = socket.address();
  if (!address || typeof address === "string") throw new Error("No test port");
  await new Promise<void>((resolve, reject) => socket.close((error) => error ? reject(error) : resolve()));
  return address.port;
}

function productionProcess(databaseUrl: string, port: number) {
  const child = fork(path.resolve("collaboration-server/index.ts"), [], {
    execArgv: ["--import", "tsx"],
    env: {
      ...process.env, DATABASE_URL: databaseUrl,
      BETTER_AUTH_SECRET: randomBytes(32).toString("base64url"),
      BETTER_AUTH_URL: "http://localhost:3000", COLLABORATION_PORT: String(port),
    },
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  let output = "";
  child.stdout?.on("data", (chunk: Buffer) => { output += chunk.toString(); });
  child.stderr?.on("data", (chunk: Buffer) => { output += chunk.toString(); });
  return { child, getOutput: () => output };
}

async function terminate(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit");
  child.kill("SIGKILL");
  await exited;
}

async function waitUntilStarted(process: ReturnType<typeof productionProcess>): Promise<void> {
  const deadline = Date.now() + 8_000;
  while (!process.getOutput().includes('"event":"collaboration_started"')) {
    if (process.child.exitCode !== null || Date.now() > deadline) throw new Error("Production writer did not start");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe.skipIf(!process.env.DATABASE_URL)("single collaboration writer", () => {
  it("refuses a second start and permits another schema and a restart after release", async () => {
    const schema = `rimo_ws_test_${randomUUID().replaceAll("-", "")}`;
    const otherSchema = `rimo_ws_test_${randomUUID().replaceAll("-", "")}`;
    const admin = new Pool({ connectionString: process.env.DATABASE_URL });
    const first = new Pool({ connectionString: process.env.DATABASE_URL, options: `-c search_path=${schema}` });
    const second = new Pool({ connectionString: process.env.DATABASE_URL, options: `-c search_path=${schema}` });
    const independent = new Pool({ connectionString: process.env.DATABASE_URL, options: `-c search_path=${otherSchema}` });
    const releases: (() => Promise<void>)[] = [];
    try {
      await admin.query(`CREATE SCHEMA ${escapeIdentifier(schema)}`);
      await admin.query(`CREATE SCHEMA ${escapeIdentifier(otherSchema)}`);
      const releaseFirst = await acquireWriterLock(first, () => undefined);
      releases.push(releaseFirst);
      await expect(acquireWriterLock(second, () => undefined)).rejects.toBeInstanceOf(WriterAlreadyRunningError);
      releases.push(await acquireWriterLock(independent, () => undefined));
      await releaseFirst();
      releases.push(await acquireWriterLock(second, () => undefined));
    } finally {
      await Promise.all(releases.map((release) => release()));
      await Promise.all([first.end(), second.end(), independent.end()]);
      for (const name of [schema, otherSchema]) {
        if (!/^rimo_ws_test_[a-f0-9]{32}$/.test(name)) throw new Error("Unexpected test schema");
        await admin.query(`DROP SCHEMA IF EXISTS ${escapeIdentifier(name)} CASCADE`);
      }
      await admin.end();
    }
  });

  it("fails a second production process and exits immediately when its lock session is lost", async () => {
    const suffix = randomUUID().replaceAll("-", "");
    const schema = `rimo_ws_test_${suffix}`;
    const applicationName = `rimo-writer-test-${suffix}`;
    const admin = new Pool({ connectionString: process.env.DATABASE_URL });
    const processes: ReturnType<typeof productionProcess>[] = [];
    try {
      await admin.query(`CREATE SCHEMA ${escapeIdentifier(schema)}`);
      const databaseUrl = new URL(process.env.DATABASE_URL!);
      databaseUrl.searchParams.set("options", `-c search_path=${schema}`);
      databaseUrl.searchParams.set("application_name", applicationName);
      const first = productionProcess(databaseUrl.toString(), await freePort());
      processes.push(first);
      await waitUntilStarted(first);
      const second = productionProcess(databaseUrl.toString(), await freePort());
      processes.push(second);
      const [secondCode] = await once(second.child, "exit");
      expect(secondCode).toBe(1);
      expect(second.getOutput()).toContain('"event":"collaboration_writer_already_running"');
      const firstExit = once(first.child, "exit");
      const killed = await admin.query<{ terminated: boolean }>(
        "SELECT pg_terminate_backend(pid) AS terminated FROM pg_stat_activity WHERE application_name = $1",
        [applicationName],
      );
      expect(killed.rows).toHaveLength(1);
      expect(killed.rows[0].terminated).toBe(true);
      const [firstCode] = await firstExit;
      expect(firstCode).toBe(1);
      expect(first.getOutput()).toContain('"event":"collaboration_writer_lock_lost"');
    } finally {
      await Promise.all(processes.map(({ child }) => terminate(child)));
      if (!/^rimo_ws_test_[a-f0-9]{32}$/.test(schema)) throw new Error("Unexpected test schema");
      await admin.query(`DROP SCHEMA IF EXISTS ${escapeIdentifier(schema)} CASCADE`);
      await admin.end();
    }
  }, 20_000);
});
