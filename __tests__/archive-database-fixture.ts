import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";

import * as Y from "yjs";

import { getRichTextJson } from "../lib/board/rich-text/document";
import { importBoardArchive } from "../server/archive/import";
import { sha256 } from "../server/archive/format";
import { downloadAsset } from "../server/assets";
import { getAuth } from "../server/auth";
import { getPool } from "../server/db";
import { runMigrations } from "../server/migrations";
import { verifyFixtureOwner } from "./verified-owner-fixture";

async function restore(): Promise<void> {
  await runMigrations();
  const owner = await getAuth({ allowSignUp: true }).api.signUpEmail({ body: {
    name: "Новый владелец архива", email: "archive-restore@example.test", password: randomBytes(24).toString("base64url"),
  } });
  await verifyFixtureOwner(getPool(), owner.user.id);
  const bytes = await readFile(process.argv[2]);
  const board = await importBoardArchive(new Request("http://localhost:3000/api/boards/import", {
    method: "POST", headers: { "content-type": "application/zip" }, body: new Uint8Array(bytes),
  }), owner.user.id);
  const row = (await getPool().query<{ state: Buffer }>("SELECT state FROM board_documents WHERE board_id = $1", [board.id])).rows[0];
  const document = new Y.Doc();
  try {
    Y.applyUpdate(document, row.state);
    const assetId = String(document.getMap<Y.Map<unknown>>("layers").get("image")!.get("src")).split("/").at(-1)!;
    const image = new Uint8Array(await (await downloadAsset(assetId, owner.user.id)).arrayBuffer());
    process.stdout.write(`${JSON.stringify({
      ownerId: board.ownerId, schemaVersion: document.getMap("meta").get("schemaVersion"), assetId,
      imageSha: sha256(image), rich: getRichTextJson(document, "rich"), orphan: getRichTextJson(document, "deleted"),
      layerIds: document.getArray("layerIds").toArray(),
      frameIds: document.getArray("frameIds").toArray(), frames: document.getMap("frames").toJSON(),
    })}\n`);
  } finally { document.destroy(); }
}

restore().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : "Archive database restore failed"}\n`);
  process.exitCode = 1;
}).finally(() => getPool().end());
