import { cp, mkdir } from "node:fs/promises";
import path from "node:path";

const target = path.resolve(".next/standalone");
await mkdir(path.join(target, ".next"), { recursive: true });
await cp("public", path.join(target, "public"), {
  recursive: true,
  filter: (source) => path.relative("public", source).split(path.sep)[0] !== "uploads",
});
await cp(".next/static", path.join(target, ".next/static"), { recursive: true });
