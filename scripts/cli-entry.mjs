import { realpath } from "node:fs/promises";
import { pathToFileURL } from "node:url";

/**
 * Match Node's resolved ESM path even when argv uses a release symlink.
 * @param {string} moduleUrl
 * @param {string | undefined} [entryFile]
 * @returns {Promise<boolean>}
 */
export async function isCliEntry(moduleUrl, entryFile = process.argv[1]) {
  if (!entryFile || entryFile === "-") return false;
  try { return moduleUrl === pathToFileURL(await realpath(entryFile)).href; }
  catch { return false; }
}
