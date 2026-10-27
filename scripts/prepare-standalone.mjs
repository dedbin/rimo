import { cp, mkdir, readdir, rm } from "node:fs/promises";
import path from "node:path";

const target = path.resolve(".next/standalone");
await mkdir(path.join(target, ".next"), { recursive: true });
await cp("public", path.join(target, "public"), {
  recursive: true,
  filter: (source) => path.relative("public", source).split(path.sep)[0] !== "uploads",
});
await cp(".next/static", path.join(target, ".next/static"), { recursive: true });

// Next traces dotenv files into standalone; configuration belongs to runtime.
for (const name of await readdir(target)) {
  if (/^\.env(?:\.[a-zA-Z0-9_-]+)*$/.test(name)) {
    await rm(path.join(target, name), { force: true });
  }
}
