// @vitest-environment node
import { describe, expect, it } from "vitest";

import { FILL_POSTGRES_SQL, POSTGRES_FILLER, withPostgresResource } from "./postgres-resource-compose";
import { startPostgresFixture } from "./postgres-resource-session";

describe.skipIf(process.env.RIMO_TEST_DOCKER_POSTGRES_RESOURCES !== "1")("PostgreSQL disk-full through actual collaboration", () => {
  it("withholds persisted ACK during relation ENOSPC and restores acknowledged plus pending edits after freeing only filler", async () => {
    await withPostgresResource(async (context) => {
      const fixture = startPostgresFixture(context);
      try {
        const baseline = await fixture.event("baseline");
        expect(baseline.clientSaved).toBe(true);
        expect(baseline.revision).toBeGreaterThan(0);
        const filled = await context.sql(FILL_POSTGRES_SQL, true);
        expect(filled.code).not.toBe(0);
        expect(filled.stderr.toString("utf8").match(/ERROR:\s+([0-9A-Z]{5})/)?.[1]).toBe("53100");
        const fs = await context.run(["exec", "-T", "db", "stat", "-f", "-c", "%a", "/var/lib/postgresql"]);
        expect(fs.stdout.toString("utf8").trim()).toBe("0");
        fixture.send("edit");
        const failure = await fixture.event("failure");
        expect(failure).toMatchObject({ noNewAck: true, clientSaved: false, databaseUnchanged: true, pendingLayers: 1_000 });
        const logs = (await context.run(["logs", "--no-color", "--no-log-prefix", "db"])).stdout.toString("utf8");
        expect(/53100\s+ERROR:.*could not extend file/.test(logs), "PostgreSQL did not report disk-full relation extension").toBe(true);
        expect(logs.includes("INSERT INTO board_documents"), "PostgreSQL did not attribute the write failure to the real snapshot query").toBe(true);
        expect(/\bPANIC:/.test(logs), "PostgreSQL reported PANIC during the write failure").toBe(false);
        await context.run(["exec", "-T", "db", "unlink", POSTGRES_FILLER]);
        fixture.send("recover");
        const recovered = await fixture.event("recovered");
        expect(recovered).toMatchObject({ clientSaved: true, allPreviouslyAckPresent: true, pendingLayersPresent: true });
        expect(recovered.revision).toBeGreaterThan(baseline.revision as number);
        expect(recovered.bytes).toBeGreaterThan(baseline.bytes as number);
        const reloaded = await fixture.event("reloaded");
        expect(reloaded).toMatchObject({ clientSaved: true, allPreviouslyAckPresent: true, pendingLayersPresent: true, layers: 1_001 });
        expect(reloaded.revision).toBeGreaterThanOrEqual(recovered.revision as number);
        fixture.closeInput();
        await fixture.done;
        process.stdout.write(`${JSON.stringify({
          test: "postgres_tmpfs_collaboration", fillerSqlState: "53100", writeSqlState: "53100", failureKind: "relation_extension",
          noNewAckWhileFull: true, clientSavedWhileFull: false, baselineUnchangedDuringFailure: true,
          baselineRevision: baseline.revision, recoveredRevision: recovered.revision,
          recoveredBytes: recovered.bytes, reloadedLayers: reloaded.layers, allPreviouslyAckPresent: true, pendingLayersPresent: true,
        })}\n`);
      } finally { await fixture.stop(); }
    }, true);
  }, 180_000);
});
