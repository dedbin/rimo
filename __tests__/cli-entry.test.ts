// @vitest-environment node
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, symlink, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { isCliEntry } from "../scripts/cli-entry.mjs";

const execute = promisify(execFile);
const temporaryRoot = path.resolve("temp");
let resolvedRoot: string;
let directory: string;
let fixture: string;
let alias: string;

beforeAll(async () => {
  await mkdir(temporaryRoot, { recursive: true });
  resolvedRoot = await realpath(temporaryRoot);
  directory = await mkdtemp(path.join(resolvedRoot, "cli-entry-unit-"));
  const realDirectory = path.join(directory, "real");
  await mkdir(realDirectory);
  fixture = path.join(realDirectory, "entry.mjs");
  const helper = pathToFileURL(path.resolve("scripts/cli-entry.mjs")).href;
  await writeFile(fixture, `import { isCliEntry } from ${JSON.stringify(helper)};\n` +
    'if (await isCliEntry(import.meta.url)) process.stdout.write("cli-executed");\n');
  alias = path.join(directory, "current");
  await symlink(realDirectory, alias, process.platform === "win32" ? "junction" : "dir");
});

afterAll(async () => {
  if (!directory) return;
  const resolvedDirectory = await realpath(directory);
  if (path.dirname(resolvedDirectory) !== resolvedRoot ||
      !path.basename(resolvedDirectory).startsWith("cli-entry-unit-")) throw new Error("Unsafe CLI test cleanup");
  if (alias) await unlink(alias).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; });
  await rm(resolvedDirectory, { recursive: true, force: true });
});

async function cli(args: string[]): Promise<string> {
  const result = await execute(process.execPath, args, { cwd: directory, timeout: 10_000, windowsHide: true });
  expect(result.stderr).toBe("");
  return result.stdout;
}

describe("resolved ESM CLI entry", () => {
  it("runs a direct absolute entry", async () => {
    expect(await cli([fixture])).toBe("cli-executed");
  });

  it("runs a direct relative entry", async () => {
    expect(await cli([path.relative(directory, fixture)])).toBe("cli-executed");
  });

  it("runs through a release directory alias", async () => {
    expect(await cli([path.join(alias, "entry.mjs")])).toBe("cli-executed");
  });

  it("does not run when the module is imported from an eval entry", async () => {
    expect(await cli(["--input-type=module", "-e", `await import(${JSON.stringify(pathToFileURL(fixture).href)});`])).toBe("");
  });

  it("does not match another existing entry", async () => {
    expect(await isCliEntry(pathToFileURL(fixture).href, path.resolve("scripts/cli-entry.mjs"))).toBe(false);
  });

  it.each(["", "-", "does-not-exist.mjs"])("ignores a non-file entry %j", async (entry) => {
    expect(await isCliEntry(pathToFileURL(fixture).href, entry)).toBe(false);
  });
});
