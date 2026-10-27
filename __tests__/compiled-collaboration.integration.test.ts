// @vitest-environment node
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";

import { escapeIdentifier, Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import * as Y from "yjs";

import { insertRectangle, ORIGIN, waitFor } from "../collaboration-server/__tests__/helpers";
import { getRichTextJson, writeRichTextFragment } from "../lib/board/rich-text/document";
import { buildCollaboration } from "../scripts/build-collaboration.mjs";
import { getAuth } from "../server/auth";
import { createBoard } from "../server/boards";
import { getPool } from "../server/db";
import { acceptInvite, createInvite, revokeInvite } from "../server/invites";
import { runMigrations } from "../server/migrations";

import { compiledClient, freeCompiledPort, startCompiledRuntime } from "./compiled-collaboration-fixtures";

const databaseUrl = process.env.RIMO_TEST_DATABASE_URL;
const hash = (state: Uint8Array): string => createHash("sha256").update(state).digest("hex");
const content = { type: "doc", content: [{ type: "paragraph", content: [
  { type: "text", text: "Native ESM ", marks: [{ type: "bold" }] },
  { type: "inlineMath", attrs: { latex: "x^2 + y^2" } },
] }] };

async function authenticate(route: string, body: Record<string, unknown>): Promise<{ cookie: string; userId: string }> {
  const response = await getAuth().handler(new Request(`${ORIGIN}/api/auth${route}`, {
    method: "POST", headers: { origin: ORIGIN, "content-type": "application/json" }, body: JSON.stringify(body),
  }));
  expect(response.status).toBe(200);
  const result = await response.json() as { user: { id: string } };
  return { cookie: response.headers.getSetCookie().map(value => value.split(";")[0]).join("; "), userId: result.user.id };
}

describe.skipIf(!databaseUrl)("actual compiled collaboration process with PostgreSQL", () => {
  it("keeps native Yjs identity, durable ACKs, XML rejection, ACL revocation and graceful restart", async () => {
    const schema = `rimo_compiled_test_${randomUUID().replaceAll("-", "")}`;
    const admin = new Pool({ connectionString: databaseUrl, connectionTimeoutMillis: 3_000, statement_timeout: 5_000 });
    const clients: ReturnType<typeof compiledClient>[] = [];
    const runtimes: ReturnType<typeof startCompiledRuntime>[] = [];
    let created = false;
    let pool: Pool | undefined;
    let directory: string | undefined;
    const root = path.resolve("temp");
    try {
      await admin.query(`CREATE SCHEMA ${escapeIdentifier(schema)}`);
      created = true;
      const isolated = new URL(databaseUrl!);
      isolated.searchParams.set("options", `-c search_path=${schema}`);
      const secret = randomBytes(48).toString("base64url");
      vi.stubEnv("DATABASE_URL", isolated.toString());
      vi.stubEnv("BETTER_AUTH_SECRET", secret);
      vi.stubEnv("BETTER_AUTH_URL", ORIGIN);
      pool = getPool();
      expect((await pool.query<{ schema: string }>("SELECT current_schema() AS schema")).rows[0].schema).toBe(schema);
      await runMigrations();
      const email = `${schema}@example.test`;
      const password = randomBytes(24).toString("base64url");
      const ownerAccount = await getAuth({ allowSignUp: true }).api.signUpEmail({ body: { email, password, name: "Compiled runtime test" } });
      const ownerCookie = (await authenticate("/sign-in/email", { email, password })).cookie;
      const guestAccount = await authenticate("/sign-in/anonymous", {});
      const boardId = (await createBoard(ownerAccount.user.id, "Compiled runtime boundary")).id;
      const invitation = await createInvite(boardId, ownerAccount.user.id, "editor");
      await acceptInvite(guestAccount.userId, invitation.token, "Compiled guest", true);
      await mkdir(root, { recursive: true });
      directory = await mkdtemp(path.join(root, "compiled-pg-"));
      const entry = path.join(directory, "index.mjs");
      await buildCollaboration({ outfile: entry });
      const port = await freeCompiledPort();
      const first = startCompiledRuntime(entry, isolated.toString(), port, secret);
      runtimes.push(first);
      expect(await first.ready()).toEqual({ type: "native-runtime", nativeYjs: true, cjsYjsLoaded: false, tsxLoaded: false });
      const owner = compiledClient(port, boardId, ownerCookie);
      const guest = compiledClient(port, boardId, guestAccount.cookie);
      clients.push(owner, guest);
      await Promise.all([owner.connect(), guest.connect()]);
      guest.document.transact(() => {
        insertRectangle(guest.document, "shared", 42);
        writeRichTextFragment(guest.document.getXmlFragment("text:formula"), content);
      });
      await waitFor(() => owner.document.getMap("layers").has("shared") && owner.isSaved() && guest.isSaved());
      expect(getRichTextJson(owner.document, "formula")).toEqual(content);
      const readStored = async () => {
        const result = await pool!.query<{ state: Buffer; revision: string }>(
          "SELECT state, revision FROM board_documents WHERE board_id = $1", [boardId]);
        expect(result.rows).toHaveLength(1);
        return result.rows[0];
      };
      const acknowledged = await readStored();
      expect(Number(acknowledged.revision)).toBe(guest.acknowledgements.at(-1)!.revision);
      expect(hash(acknowledged.state)).toBe(hash(Y.encodeStateAsUpdate(owner.document)));
      const malformed = compiledClient(port, boardId, ownerCookie);
      clients.push(malformed);
      await malformed.connect();
      const beforeRejection = malformed.acknowledgements.at(-1)!;
      malformed.document.getXmlFragment("text:forbidden").insert(0, [new Y.XmlElement("script")]);
      await waitFor(() => malformed.isClosed());
      // A status request may repeat the existing ACK; the rejected edit must
      // never advance its revision/snapshot or become locally Saved.
      expect(malformed.acknowledgements.every(ack => ack.revision <= beforeRejection.revision)).toBe(true);
      expect(malformed.acknowledgements.at(-1)!.snapshot).toBe(beforeRejection.snapshot);
      expect(malformed.isSaved()).toBe(false);
      expect(await readStored()).toEqual(acknowledged);
      expect(owner.document.share.has("text:forbidden")).toBe(false);
      expect(owner.isClosed()).toBe(false);
      malformed.destroy();
      await revokeInvite(boardId, ownerAccount.user.id, invitation.invite.id);
      await waitFor(() => guest.isClosed(), 8_000);
      expect(owner.isClosed()).toBe(false);
      insertRectangle(owner.document, "after-revoke", 84);
      await waitFor(() => owner.isSaved());
      const observer = compiledClient(port, boardId, ownerCookie);
      clients.push(observer);
      await observer.connect();
      insertRectangle(owner.document, "shutdown-drain", 126);
      await waitFor(() => observer.document.getMap("layers").has("shutdown-drain"));
      expect(owner.isSaved()).toBe(false);
      const finalHash = hash(Y.encodeStateAsUpdate(observer.document));
      await first.stop();
      const drained = await readStored();
      expect(hash(drained.state)).toBe(finalHash);
      expect(Number(drained.revision)).toBeGreaterThan(Number(acknowledged.revision));
      const restartedPort = await freeCompiledPort();
      const restarted = startCompiledRuntime(entry, isolated.toString(), restartedPort, secret);
      runtimes.push(restarted);
      expect(await restarted.ready()).toEqual({ type: "native-runtime", nativeYjs: true, cjsYjsLoaded: false, tsxLoaded: false });
      const restored = compiledClient(restartedPort, boardId, ownerCookie);
      clients.push(restored);
      await restored.connect();
      expect(restored.isSaved()).toBe(true);
      expect(hash(Y.encodeStateAsUpdate(restored.document))).toBe(finalHash);
      expect(restored.acknowledgements.at(-1)!.revision).toBe(Number(drained.revision));
      expect(restored.document.getMap<Y.Map<unknown>>("layers").get("shutdown-drain")?.get("x")).toBe(126);
      expect(getRichTextJson(restored.document, "formula")).toEqual(content);
    } finally {
      const cleanupErrors: unknown[] = [];
      for (const client of clients) { try { client.destroy(); } catch (error) { cleanupErrors.push(error); } }
      for (const runtime of runtimes) { try { await runtime.stop(); } catch (error) { cleanupErrors.push(error); } }
      try { await pool?.end(); } catch (error) { cleanupErrors.push(error); }
      try {
        if (!/^rimo_compiled_test_[a-f0-9]{32}$/.test(schema)) throw new Error("Unexpected compiled test schema");
        if (created) await admin.query(`DROP SCHEMA ${escapeIdentifier(schema)} CASCADE`);
      } catch (error) { cleanupErrors.push(error); }
      try { await admin.end(); } catch (error) { cleanupErrors.push(error); }
      vi.unstubAllEnvs();
      if (directory) {
        if (path.dirname(directory) !== root || !path.basename(directory).startsWith("compiled-pg-")) throw new Error("Unsafe compiled test cleanup path");
        try { await rm(directory, { recursive: true, force: true }); } catch (error) { cleanupErrors.push(error); }
      }
      if (cleanupErrors.length) throw new Error(`Compiled test cleanup failed (${cleanupErrors.length} operations)`);
    }
  }, 45_000);
});
