import { createHash } from "node:crypto";
import { SourceMap } from "node:module";

export const COLLABORATION_BUNDLE_URL = "file:///app/dist/collaboration/index.mjs";
const position = (value) => Number.isSafeInteger(value) && value >= 0;
const moduleSource = (frame, name) => frame.sourceUrl.replaceAll("\\", "/").endsWith(`/collaboration-server/${name}.ts`);
const isPersistence = (frame) => frame.functionName === "persist" && moduleSource(frame, "persistence");

function resolveFrames(nodes, sourceMap) {
  let map, mapSha256 = null, reason = "source-map-unavailable";
  if (sourceMap !== undefined) try {
    const text = typeof sourceMap === "string" ? sourceMap : JSON.stringify(sourceMap);
    mapSha256 = createHash("sha256").update(text).digest("hex");
    const payload = JSON.parse(text);
    if (payload.version !== 3 || !Array.isArray(payload.sources) || !payload.sources.every((source) => typeof source === "string") ||
        !Array.isArray(payload.names) || typeof payload.mappings !== "string") throw new Error("Invalid source map");
    map = new SourceMap(payload);
    reason = "bundle-frame-unmapped";
  } catch { reason = "source-map-invalid"; }
  let mappedFrames = 0, unmappedFrames = 0;
  const frames = new Map();
  for (const node of nodes.values()) {
    const frame = node.callFrame;
    const bundled = frame.url === COLLABORATION_BUNDLE_URL || /\/dist\/collaboration\/index\.mjs$/.test(frame.url);
    const resolved = { ...frame, sourceUrl: frame.url, bundled, mapped: false };
    if (bundled) {
      if (map && frame.url === COLLABORATION_BUNDLE_URL && position(frame.lineNumber) && position(frame.columnNumber)) try {
        const entry = map.findEntry(frame.lineNumber, frame.columnNumber);
        // findEntry can return a mapping from a preceding line: it cannot identify this function.
        if (entry.generatedLine === frame.lineNumber && position(entry.generatedColumn) && entry.generatedColumn <= frame.columnNumber &&
            typeof entry.originalSource === "string" && entry.originalSource.length > 0 &&
            position(entry.originalLine) && position(entry.originalColumn)) {
          resolved.sourceUrl = entry.originalSource;
          resolved.original = { url: entry.originalSource, line: entry.originalLine + 1, column: entry.originalColumn + 1 };
          resolved.mapped = true;
        }
      } catch { /* A failed mapping remains unresolved; never infer a source from a function name. */ }
      if (resolved.mapped) mappedFrames += 1; else unmappedFrames += 1;
    }
    frames.set(node.id, resolved);
  }
  const bundledFrames = mappedFrames + unmappedFrames;
  return { frames, coverage: { status: !bundledFrames ? "not-needed" : !mappedFrames ? "unavailable" : unmappedFrames ? "partial" : "complete",
    bundleUrl: COLLABORATION_BUNDLE_URL, mapSha256, bundledFrames, mappedFrames, unmappedFrames,
    ...(unmappedFrames ? { reason } : {}) } };
}

/** @param {{sourceMap?: string | object}} options */
export function summarizeCpuProfile(profile, { sourceMap } = {}) {
  const nodes = new Map(profile.nodes.map((node) => [node.id, node]));
  const { frames, coverage } = resolveFrames(nodes, sourceMap);
  const parents = new Map();
  for (const node of nodes.values()) for (const id of node.children ?? []) parents.set(id, node.id);
  const exclusive = new Map();
  const groups = { persist: 0, incomingShadowValidation: 0, strictDocumentValidation: 0, modelParsing: 0,
    richTextCodec: 0, yjsEncoding: 0, garbageCollection: 0 };
  const encodingCallers = { canonicalAlignment: 0, validatedShadow: 0, persistence: 0, other: 0, unresolved: 0 };
  let total = 0;
  let idle = 0;
  let unmappedActive = 0;
  for (let index = 0; index < profile.samples.length; index += 1) {
    const micros = profile.timeDeltas?.[index] ?? 1_000;
    const node = nodes.get(profile.samples[index]);
    if (!node) continue;
    total += micros;
    if (node.callFrame.functionName === "(idle)") { idle += micros; continue; }
    const stack = [];
    for (let current = node; current; current = nodes.get(parents.get(current.id))) stack.push(frames.get(current.id));
    const unmapped = stack.some((frame) => frame.bundled && !frame.mapped);
    if (unmapped) unmappedActive += micros;
    const leaf = node.callFrame;
    const key = JSON.stringify([leaf.functionName, leaf.url, leaf.lineNumber, leaf.columnNumber, frames.get(node.id).original]);
    exclusive.set(key, (exclusive.get(key) ?? 0) + micros);
    if (stack.some(isPersistence)) groups.persist += micros;
    if (stack.some((frame) => frame.functionName === "validateShadowUpdate")) groups.incomingShadowValidation += micros;
    if (stack.some((frame) => frame.functionName === "validateDocument")) groups.strictDocumentValidation += micros;
    if (stack.some((frame) => /parseLayer|readBoardModel|parseFrame/.test(frame.functionName))) groups.modelParsing += micros;
    if (stack.some((frame) => frame.sourceUrl.includes("/rich-text/") || /[Pp]rosemirror|[Rr]ichText/.test(frame.functionName))) groups.richTextCodec += micros;
    if (stack.some((frame) => /encodeStateAsUpdate|writeStateAsUpdate|writeClientsStructs|writeStructs/.test(frame.functionName))) {
      groups.yjsEncoding += micros;
      // Leaf-to-root order attributes nested encoding to its nearest semantic owner.
      const owner = stack.find((frame) => isPersistence(frame) || frame.functionName === "validateShadowUpdate" || moduleSource(frame, "validation-cache"));
      const caller = unmapped ? "unresolved" : !owner ? "other" : isPersistence(owner) ? "persistence"
        : owner.functionName === "validateShadowUpdate" ? "validatedShadow" : "canonicalAlignment";
      encodingCallers[caller] += micros;
    }
    if (leaf.functionName === "(garbage collector)") groups.garbageCollection += micros;
  }
  const active = total - idle;
  const percent = (value) => active ? Math.round(value / active * 10_000) / 100 : 0;
  const measure = (micros, incomplete = false) => incomplete
    ? { ms: null, activePercent: null, observedMs: micros / 1_000, observedActivePercent: percent(micros), reason: "unmapped-bundle-frames" }
    : { ms: micros / 1_000, activePercent: percent(micros) };
  return { version: 2, sampledMs: total / 1_000, activeMs: active / 1_000, idleMs: idle / 1_000, samples: profile.samples.length,
    note: "Inclusive groups overlap; denominator excludes idle samples. Sampling adds overhead. Null attribution is unknown; observedMs is a lower bound. Zero samples do not prove zero CPU cost.",
    sourceMapping: { ...coverage, unmappedActiveMs: unmappedActive / 1_000 },
    inclusive: Object.fromEntries(Object.entries(groups).map(([key, micros]) => [key, measure(micros,
      unmappedActive > 0 && !["yjsEncoding", "garbageCollection"].includes(key))])),
    encodingCallers: Object.fromEntries(Object.entries(encodingCallers).map(([key, micros]) => [key, measure(micros,
      encodingCallers.unresolved > 0 && !["unresolved", "other"].includes(key))])),
    topExclusive: [...exclusive].toSorted((a, b) => b[1] - a[1]).slice(0, 30).map(([key, micros]) => {
      const [name, url, line, column, original] = JSON.parse(key);
      return { name: name || "(anonymous)", url, line: line + 1, column: column + 1,
        ...(original ? { original } : {}), ms: micros / 1_000, activePercent: percent(micros) };
    }) };
}
