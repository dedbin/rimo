// @vitest-environment node
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

import { buildCollaboration } from "../scripts/build-collaboration.mjs";

const execute = promisify(execFile);

describe("compiled collaboration native module boundary", () => {
  it("builds the production index and imports its factory/document/codec graph with one native Yjs and no network", async () => {
    const root = path.resolve("temp");
    await mkdir(root, { recursive: true });
    const directory = await mkdtemp(path.join(root, "compiled-runtime-"));
    try {
      const runtime = path.join(directory, "index.mjs");
      const result = await buildCollaboration({ outfile: runtime });
      expect(result.warnings).toEqual([]);
      expect(Object.keys(result.metafile!.inputs).some(filename => filename.includes("node_modules/"))).toBe(false);
      expect(Object.values(result.metafile!.outputs).flatMap(output => output.imports).every(item => item.kind === "import-statement")).toBe(true);
      const source = await readFile(runtime, "utf8");
      expect(source).not.toMatch(/\b(__commonJS|__toESM)\b/);
      expect(source).not.toMatch(/from\s*["']@\//);
      expect(source).toContain("//# sourceMappingURL=index.mjs.map");
      const map = JSON.parse(await readFile(`${runtime}.map`, "utf8")) as { sources: string[] };
      expect(map.sources.length).toBeGreaterThan(10);
      expect(map.sources.some(filename => /(?:^|[\\/])\.env(?:\.|$)/.test(filename))).toBe(false);
      const smoke = path.join(directory, "smoke.mjs");
      await buildCollaboration({ entryPoint: "__tests__/fixtures/collaboration-native-smoke.ts", outfile: smoke });
      const imported = await execute(process.execPath, [
        `--import=${pathToFileURL(path.resolve("__tests__/fixtures/collaboration-no-network.mjs")).href}`, smoke,
      ], { env: { ...process.env, NODE_OPTIONS: "" }, timeout: 15_000, maxBuffer: 65_536, windowsHide: true });
      expect(imported.stderr).toBe("");
      expect(JSON.parse(imported.stdout)).toEqual({ nativeYjs: true, hocuspocusIdentity: true, xmlIdentity: true,
        richTextRoundtrip: true, strictXmlRejected: true, cjsYjsLoaded: false, network: { connect: 0, listen: 0 }, tsxLoaded: false });
      const mapped = path.join(directory, "mapped.mjs");
      await buildCollaboration({ entryPoint: "__tests__/fixtures/collaboration-source-map.ts", outfile: mapped });
      const failure = await execute(process.execPath, ["--enable-source-maps", mapped],
        { timeout: 5_000, windowsHide: true, maxBuffer: 16_384 })
        .then(() => null, (error: { code: number; stderr: string }) => error);
      expect(failure?.code).toBe(1);
      expect(failure?.stderr).toMatch(/collaboration-source-map\.ts:2:9/);
    } finally {
      if (path.dirname(directory) !== root || !path.basename(directory).startsWith("compiled-runtime-")) throw new Error("Unsafe compiled runtime cleanup path");
      await rm(directory, { recursive: true, force: true });
    }
  }, 25_000);
});
