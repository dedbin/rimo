import path from "node:path";
import { pathToFileURL } from "node:url";

// Next's standalone entry changes cwd. Keep persistent files outside its build directory.
process.env.ASSET_STORAGE_PATH = path.resolve(process.env.ASSET_STORAGE_PATH ?? "data/assets");
await import(pathToFileURL(path.resolve(".next/standalone/server.js")).href);
