import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build, stop } from "esbuild";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Keep installed dependencies external so Node resolves one native ESM Yjs. */
export async function buildCollaboration({ entryPoint = "collaboration-server/index.ts",
  outfile = path.join(root, "dist/collaboration/index.mjs") } = {}) {
  return build({
    absWorkingDir: root, entryPoints: [entryPoint], outfile,
    bundle: true, packages: "external", format: "esm", platform: "node", target: "node22",
    sourcemap: "linked", sourcesContent: true, metafile: true,
    tsconfig: path.join(root, "tsconfig.json"), logLevel: "silent",
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    await buildCollaboration();
    process.stdout.write("Compiled collaboration runtime: dist/collaboration/index.mjs\n");
  } finally { stop(); }
}
