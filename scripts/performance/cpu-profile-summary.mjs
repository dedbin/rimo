export function summarizeCpuProfile(profile) {
  const nodes = new Map(profile.nodes.map((node) => [node.id, node]));
  const parents = new Map();
  for (const node of nodes.values()) for (const id of node.children ?? []) parents.set(id, node.id);
  const exclusive = new Map();
  const groups = { persist: 0, incomingShadowValidation: 0, strictDocumentValidation: 0, modelParsing: 0,
    richTextCodec: 0, yjsEncoding: 0, garbageCollection: 0 };
  const encodingCallers = { canonicalAlignment: 0, validatedShadow: 0, persistence: 0, other: 0 };
  let total = 0;
  let idle = 0;
  for (let index = 0; index < profile.samples.length; index += 1) {
    const micros = profile.timeDeltas?.[index] ?? 1_000;
    const node = nodes.get(profile.samples[index]);
    if (!node) continue;
    total += micros;
    if (node.callFrame.functionName === "(idle)") { idle += micros; continue; }
    const stack = [];
    for (let current = node; current; current = nodes.get(parents.get(current.id))) stack.push(current.callFrame);
    const leaf = node.callFrame;
    const key = JSON.stringify([leaf.functionName, leaf.url, leaf.lineNumber]);
    exclusive.set(key, (exclusive.get(key) ?? 0) + micros);
    if (stack.some((frame) => frame.functionName === "persist" && frame.url.includes("persistence"))) groups.persist += micros;
    if (stack.some((frame) => frame.functionName === "validateShadowUpdate")) groups.incomingShadowValidation += micros;
    if (stack.some((frame) => frame.functionName === "validateDocument")) groups.strictDocumentValidation += micros;
    if (stack.some((frame) => /parseLayer|readBoardModel|parseFrame/.test(frame.functionName))) groups.modelParsing += micros;
    if (stack.some((frame) => frame.url.includes("/rich-text/") || /[Pp]rosemirror|[Rr]ichText/.test(frame.functionName))) groups.richTextCodec += micros;
    if (stack.some((frame) => /encodeStateAsUpdate|writeStateAsUpdate|writeClientsStructs|writeStructs/.test(frame.functionName))) {
      groups.yjsEncoding += micros;
      const caller = stack.some((frame) => frame.functionName === "persist" && frame.url.includes("persistence")) ? "persistence"
        : stack.some((frame) => frame.functionName === "validateShadowUpdate") ? "validatedShadow"
          : stack.some((frame) => frame.url.includes("validation-cache")) ? "canonicalAlignment" : "other";
      encodingCallers[caller] += micros;
    }
    if (leaf.functionName === "(garbage collector)") groups.garbageCollection += micros;
  }
  const active = total - idle;
  const percent = (value) => active ? Math.round(value / active * 10_000) / 100 : 0;
  return { sampledMs: total / 1_000, activeMs: active / 1_000, idleMs: idle / 1_000, samples: profile.samples.length,
    note: "Inclusive groups overlap; percent denominator excludes idle samples. CPU sampling adds overhead and is diagnostic.",
    inclusive: Object.fromEntries(Object.entries(groups).map(([key, micros]) => [key, { ms: micros / 1_000, activePercent: percent(micros) }])),
    encodingCallers: Object.fromEntries(Object.entries(encodingCallers).map(([key, micros]) => [key, { ms: micros / 1_000, activePercent: percent(micros) }])),
    topExclusive: [...exclusive].toSorted((a, b) => b[1] - a[1]).slice(0, 30).map(([key, micros]) => {
      const [name, url, line] = JSON.parse(key);
      return { name: name || "(anonymous)", url, line: line + 1, ms: micros / 1_000, activePercent: percent(micros) };
    }) };
}
