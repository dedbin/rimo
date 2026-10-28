// @vitest-environment node

import { randomUUID } from "node:crypto";

import type { Server } from "@hocuspocus/server";
import { escapeIdentifier, Pool } from "pg";
import * as Y from "yjs";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { initializeDocument } from "../collaboration-server/document";
import { createPostgresRepository } from "../collaboration-server/postgres-repository";
import { createCollaborationServer } from "../collaboration-server/server";
import type { CollaborationContext, SnapshotRepository } from "../collaboration-server/types";
import { createTestClient, ORIGIN, waitFor } from "../collaboration-server/__tests__/helpers";
import type { TestClient } from "../collaboration-server/__tests__/helpers";
import { getRichTextJson, textFragmentName, writeRichTextFragment } from "../lib/board/rich-text/document";
import type { RichTextDocument } from "../lib/board/rich-text/types";
import { plainTextDocument, validateRichTextDocument } from "../lib/board/rich-text/validation";
import { LayerType } from "../types/board-canvas";

const databaseUrl = process.env.RIMO_TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const schema = `rimo_text_test_${randomUUID().replaceAll("-", "")}`;
const servers: Server<CollaborationContext>[] = [];
const clients: TestClient[] = [];
const unblock: (() => void)[] = [];
let admin: Pool;
let database: Pool;

const math: RichTextDocument = {
  type: "doc", content: [
    { type: "paragraph", content: [
      { type: "text", text: "Площадь круга: ", marks: [{ type: "bold" }] },
      { type: "inlineMath", attrs: { latex: "S = \\pi r^2" } },
    ] },
    { type: "blockMath", attrs: { latex: "\\frac{x^2}{a^2} + \\frac{y^2}{b^2} = 1" } },
    { type: "orderedList", attrs: { start: 3 }, content: [
      { type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "Вычислить" }] }] },
    ] },
    { type: "codeBlock", attrs: { language: null }, content: [{ type: "text", text: "x = 1" }] },
  ],
};

function textLayer(value?: string): Y.Map<unknown> {
  return new Y.Map<unknown>([
    ["type", LayerType.Text], ["x", 10], ["y", 20], ["width", 400], ["height", 100],
    ["fill", { r: 0, g: 0, b: 0 }], ["fontSize", 16],
    ...(value === undefined ? [] : [["value", value] as [string, unknown]]),
  ]);
}

function insertText(document: Y.Doc, input: RichTextDocument = math): void {
  document.transact(() => {
    document.getMap<Y.Map<unknown>>("layers").set("text", textLayer());
    writeRichTextFragment(document.getXmlFragment(textFragmentName("text")), input);
    document.getArray<string>("layerIds").push(["text"]);
  });
}

async function newBoard(): Promise<string> {
  const id = randomUUID();
  await database.query("INSERT INTO boards(id) VALUES ($1)", [id]);
  return id;
}

async function startServer(boardId: string, repository = createPostgresRepository(database)): Promise<Server<CollaborationContext>> {
  const server = createCollaborationServer({
    origins: [ORIGIN], port: 0,
    limits: { aclRefreshMs: 100, persistenceDebounceMs: 20, persistenceMaxDebounceMs: 50 },
  }, {
    repository,
    async authenticate(headers, requestedBoard) {
      const userId = headers.get("cookie")?.split("=")[1];
      if (!userId || requestedBoard !== boardId) return null;
      return { boardId, userId, sessionId: userId, name: userId, role: "editor" };
    },
    async revalidate() { return "editor"; },
  });
  await server.listen();
  servers.push(server);
  return server;
}

function client(server: Server<CollaborationContext>, boardId: string, userId = "editor"): TestClient {
  const result = createTestClient(`ws://127.0.0.1:${server.address.port}`, userId, boardId);
  clients.push(result);
  return result;
}

function firstText(document: Y.Doc): Y.XmlText {
  const paragraph = document.getXmlFragment("text:text").get(0);
  if (!(paragraph instanceof Y.XmlElement)) throw new Error("Test paragraph is missing");
  const text = paragraph.get(0);
  if (!(text instanceof Y.XmlText)) throw new Error("Test text is missing");
  return text;
}

async function seedRichBoard(): Promise<{ boardId: string; repository: SnapshotRepository }> {
  const boardId = await newBoard();
  const repository = createPostgresRepository(database);
  const initial = new Y.Doc();
  initializeDocument(initial);
  insertText(initial);
  await repository.save(boardId, Y.encodeStateAsUpdate(initial));
  initial.destroy();
  return { boardId, repository };
}

describe.skipIf(!databaseUrl)("rich-text schema through PostgreSQL and WebSocket", () => {
  beforeAll(async () => {
    admin = new Pool({ connectionString: databaseUrl });
    await admin.query(`CREATE SCHEMA ${escapeIdentifier(schema)}`);
    database = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}` });
    await database.query("CREATE TABLE boards(id uuid PRIMARY KEY)");
    await database.query(`CREATE TABLE board_documents(
      board_id uuid PRIMARY KEY REFERENCES boards(id) ON DELETE CASCADE,
      state bytea NOT NULL, revision bigint NOT NULL DEFAULT 0,
      saved_at timestamptz NOT NULL DEFAULT now()
    )`);
  });

  afterEach(async () => {
    unblock.splice(0).forEach((release) => release());
    clients.splice(0).forEach((connection) => connection.destroy());
    await Promise.all(servers.splice(0).map((server) => server.destroy()));
    await database.query("TRUNCATE board_documents, boards CASCADE");
  });

  afterAll(async () => {
    await database.end();
    if (!/^rimo_text_test_[a-f0-9]{32}$/.test(schema)) throw new Error("Unexpected rich-text test schema");
    await admin.query(`DROP SCHEMA IF EXISTS ${escapeIdentifier(schema)} CASCADE`);
    await admin.end();
  });

  it("migrates a v1 database snapshot before sync and acknowledges only the committed v2 state", async () => {
    const boardId = await newBoard();
    const legacy = new Y.Doc();
    const literal = '<img src=x onerror="alert(1)">\nРусская строка';
    legacy.getMap("meta").set("schemaVersion", 1);
    legacy.getMap<Y.Map<unknown>>("layers").set("text", textLayer(literal));
    legacy.getArray<string>("layerIds").push(["text"]);
    await database.query("INSERT INTO board_documents(board_id, state, revision) VALUES ($1, $2, 7)",
      [boardId, Buffer.from(Y.encodeStateAsUpdate(legacy))]);
    legacy.destroy();
    const repository = createPostgresRepository(database);
    let migrationStarted = false;
    let finishMigration: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => { finishMigration = resolve; });
    unblock.push(finishMigration);
    const server = await startServer(boardId, {
      ...repository,
      async save(id, state) { migrationStarted = true; await gate; return repository.save(id, state); },
    });
    const connection = client(server, boardId);
    const connecting = connection.connect();
    await waitFor(() => migrationStarted);
    expect(connection.lastAcknowledgement()).toBeUndefined();
    expect(connection.provider.isSynced).toBe(false);
    expect((await repository.load(boardId))?.revision).toBe(7);
    finishMigration();
    await connecting;
    await waitFor(() => connection.isPersisted());
    expect(connection.document.getMap("meta").get("schemaVersion")).toBe(2);
    expect(connection.document.getMap<Y.Map<unknown>>("layers").get("text")!.has("value")).toBe(false);
    expect(getRichTextJson(connection.document, "text")).toEqual(plainTextDocument(literal));
    expect(connection.lastAcknowledgement()?.revision).toBe(8);
    const persisted = await repository.load(boardId);
    expect(persisted?.revision).toBe(8);
    const restored = new Y.Doc();
    Y.applyUpdate(restored, persisted!.state);
    expect(getRichTextJson(restored, "text")).toEqual(plainTextDocument(literal));
    expect(Y.equalSnapshots(Y.snapshot(restored), Y.decodeSnapshot(Buffer.from(connection.lastAcknowledgement()!.snapshot, "base64")))).toBe(true);
    restored.destroy();
  });

  it.each([
    ["unknown XML element", (document: Y.Doc) => document.getXmlFragment("text:text").insert(0, [new Y.XmlElement("script")])],
    ["unknown XML attribute", (document: Y.Doc) => (document.getXmlFragment("text:text").get(0) as Y.XmlElement).setAttribute("onclick", "alert(1)")],
    ["unknown mark", (document: Y.Doc) => firstText(document).format(0, 1, { link: { href: "javascript:alert(1)" } })],
    ["attribute on an allowed mark", (document: Y.Doc) => firstText(document).format(0, 1, { bold: { onclick: "alert(1)" } })],
    ["invalid nesting of allowed nodes", (document: Y.Doc) => (document.getXmlFragment("text:text").get(0) as Y.XmlElement).insert(0, [new Y.XmlElement("codeBlock")])],
    ["embedded object", (document: Y.Doc) => firstText(document).insertEmbed(0, { html: "<img onerror=evil()>" })],
    ["invalid orphan fragment", (document: Y.Doc) => document.getXmlFragment("text:deleted").insert(0, [new Y.XmlElement("script")])],
    ["unknown shared root", (document: Y.Doc) => document.getMap("unexpected").set("payload", "invalid")],
  ])("rejects %s before broadcasting or replacing the committed state", async (_name, mutate) => {
    const { boardId, repository } = await seedRichBoard();
    const server = await startServer(boardId);
    const observer = client(server, boardId, "observer");
    const attacker = client(server, boardId);
    await Promise.all([observer.connect(), attacker.connect()]);
    await waitFor(() => observer.isPersisted() && attacker.isPersisted());
    const committed = await repository.load(boardId);
    const clean = getRichTextJson(observer.document, "text");
    let closed = false;
    attacker.provider.on("close", () => { closed = true; attacker.websocketProvider.disconnect(); });
    mutate(attacker.document);
    await waitFor(() => closed);
    expect(getRichTextJson(observer.document, "text")).toEqual(clean);
    expect(observer.document.share.has("unexpected")).toBe(false);
    expect(observer.document.share.has("text:deleted")).toBe(false);
    const unchanged = await repository.load(boardId);
    expect(unchanged?.revision).toBe(committed?.revision);
    expect(Buffer.from(unchanged!.state)).toEqual(Buffer.from(committed!.state));
  });

  it("merges two authors around valid math, preserves PM default attributes and reloads from the committed state", async () => {
    const boardId = await newBoard();
    const server = await startServer(boardId);
    const first = client(server, boardId);
    const second = client(server, boardId, "peer");
    await Promise.all([first.connect(), second.connect()]);
    insertText(first.document);
    const list = first.document.getXmlFragment("text:text").get(2) as Y.XmlElement;
    list.setAttribute("type", null as unknown as string);
    await waitFor(() => second.document.share.has("text:text") && first.isPersisted() && second.isPersisted());
    expect(getRichTextJson(second.document, "text")).toEqual(validateRichTextDocument(math));
    firstText(first.document).insert(0, "A");
    firstText(second.document).insert(0, "B");
    await waitFor(() => first.isPersisted() && second.isPersisted() &&
      firstText(first.document).toString().includes("A") && firstText(first.document).toString().includes("B"));
    const finalContent = getRichTextJson(first.document, "text");
    expect(getRichTextJson(second.document, "text")).toEqual(finalContent);
    expect(finalContent.content[1].attrs?.latex).toBe("\\frac{x^2}{a^2} + \\frac{y^2}{b^2} = 1");
    first.destroy(); second.destroy();
    clients.splice(0);
    await server.destroy();
    servers.splice(servers.indexOf(server), 1);
    const restarted = await startServer(boardId);
    const restored = client(restarted, boardId, "reloaded");
    await restored.connect();
    await waitFor(() => restored.isPersisted());
    expect(getRichTextJson(restored.document, "text")).toEqual(finalContent);
  });
});
