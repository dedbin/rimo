// @vitest-environment node
import { fork } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import path from "node:path";

import { escapeIdentifier, Pool } from "pg";
import * as Y from "yjs";
import { afterEach, describe, expect, it } from "vitest";

import { BOARD_ID, createTestClient, insertRectangle, waitFor } from "./helpers";
import type { TestClient } from "./helpers";

const children: ChildProcess[] = [];
const clients: TestClient[] = [];
const pools: Pool[] = [];
const schemas: string[] = [];

async function launch(schema: string): Promise<string> {
  const child = fork(path.resolve("collaboration-server/__tests__/fixtures/server-process.ts"), [], {
    execArgv: ["--import", "tsx"],
    env: { ...process.env, RIMO_WS_TEST_SCHEMA: schema },
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  children.push(child);
  child.stdout?.resume();
  child.stderr?.resume();
  const port = await new Promise<number>((resolve, reject) => {
    const deadline = setTimeout(() => reject(new Error("Collaboration child did not start")), 8_000);
    child.once("exit", () => { clearTimeout(deadline); reject(new Error("Collaboration child exited before readiness")); });
    child.on("message", (message: unknown) => {
      if (typeof message !== "object" || message === null || !("type" in message)) return;
      if (message.type === "ready" && "port" in message && typeof message.port === "number") {
        clearTimeout(deadline);
        resolve(message.port);
      }
      if (message.type === "failed") { clearTimeout(deadline); reject(new Error("Collaboration child startup failed")); }
    });
  });
  return `ws://127.0.0.1:${port}`;
}

async function kill(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit");
  child.kill("SIGKILL");
  await exited;
}

afterEach(async () => {
  clients.splice(0).forEach((client) => client.destroy());
  await Promise.all(children.splice(0).map(kill));
  await Promise.all(pools.splice(0).map((pool) => pool.end()));
  if (!schemas.length) return;
  const cleanup = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    for (const schema of schemas.splice(0)) {
      if (!/^rimo_ws_test_[a-f0-9]{32}$/.test(schema)) throw new Error("Refusing to remove an unexpected test schema");
      await cleanup.query(`DROP SCHEMA IF EXISTS ${escapeIdentifier(schema)} CASCADE`);
    }
  } finally {
    await cleanup.end();
  }
});

describe.skipIf(!process.env.DATABASE_URL)("PostgreSQL crash recovery", () => {
  it("recovers every acknowledged change after SIGKILL, including deletions", async () => {
    const schema = `rimo_ws_test_${randomUUID().replaceAll("-", "")}`;
    const admin = new Pool({ connectionString: process.env.DATABASE_URL });
    pools.push(admin);
    await admin.query(`CREATE SCHEMA ${escapeIdentifier(schema)}`);
    schemas.push(schema);
    const database = new Pool({ connectionString: process.env.DATABASE_URL, options: `-c search_path=${schema}` });
    pools.push(database);
    await database.query("CREATE TABLE boards (id uuid PRIMARY KEY)");
    await database.query(`CREATE TABLE board_documents (
      board_id uuid PRIMARY KEY REFERENCES boards(id) ON DELETE CASCADE,
      state bytea NOT NULL, revision bigint NOT NULL DEFAULT 0,
      saved_at timestamptz NOT NULL DEFAULT now()
    )`);
    await database.query("INSERT INTO boards (id) VALUES ($1)", [BOARD_ID]);
    const firstUrl = await launch(schema);
    const first = createTestClient(firstUrl, "editor");
    clients.push(first);
    await first.connect();
    insertRectangle(first.document, "deleted");
    await waitFor(() => first.isPersisted());
    first.document.transact(() => {
      first.document.getMap("layers").delete("deleted");
      first.document.getArray("layerIds").delete(0, 1);
    });
    await waitFor(() => first.isPersisted());
    insertRectangle(first.document, "survivor", 42);
    await waitFor(() => first.isPersisted());
    const committedRevision = first.lastAcknowledgement()!.revision;
    // SIGKILL bypasses all shutdown/flush hooks. Only the acknowledged DB commit can survive.
    await kill(children[0]);
    first.destroy();
    clients.splice(clients.indexOf(first), 1);

    const restartedUrl = await launch(schema);
    const restored = createTestClient(restartedUrl, "editor");
    clients.push(restored);
    await restored.connect();
    await waitFor(() => restored.isPersisted());
    expect([...restored.document.getMap("layers").keys()]).toEqual(["survivor"]);
    expect(restored.document.getMap<Y.Map<unknown>>("layers").get("survivor")!.get("x")).toBe(42);
    expect(restored.document.getArray("layerIds").toArray()).toEqual(["survivor"]);
    expect(restored.lastAcknowledgement()!.revision).toBe(committedRevision);
  }, 20_000);
});
