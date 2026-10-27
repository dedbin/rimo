import { access, cp, mkdir } from "node:fs/promises";
import path from "node:path";

const target = path.resolve(".next/standalone");
await mkdir(path.join(target, ".next"), { recursive: true });
await cp("public", path.join(target, "public"), {
  recursive: true,
  filter: (source) => path.relative("public", source).split(path.sep)[0] !== "uploads",
});
await cp(".next/static", path.join(target, ".next/static"), { recursive: true });

// These resources are read through fs at request time, rather than browser CSS.
const resources = [
  "@fontsource/noto-sans/files/noto-sans-cyrillic-400-normal.woff2",
  "@fontsource/noto-serif/files/noto-serif-cyrillic-700-italic.woff2",
  "@fontsource/noto-sans-mono/files/noto-sans-mono-latin-400-normal.woff2",
  "katex/dist/katex.min.css",
  "katex/dist/fonts/KaTeX_Main-Regular.woff2",
];
await Promise.all(resources.map((resource) => access(path.join(target, "node_modules", resource))));
