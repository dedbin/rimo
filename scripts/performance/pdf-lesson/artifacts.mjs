import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import path from "node:path";

/** Reserve one private directory; an existing path is never adopted or cleared. */
export async function reservePdfDirectory(output) {
  const directory = path.join(path.dirname(path.resolve(output)), `pdf-${randomUUID()}`);
  await mkdir(directory, { mode: 0o700 });
  return directory;
}
