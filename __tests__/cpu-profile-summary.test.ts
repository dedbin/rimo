// @vitest-environment node
import { describe, expect, it } from "vitest";

import { summarizeCpuProfile } from "../scripts/performance/cpu-profile-summary.mjs";

const bundle = "file:///app/dist/collaboration/index.mjs";
const yjs = "file:///app/node_modules/yjs/dist/yjs.mjs";
const sourceMap = { version: 3, sources: ["../../collaboration-server/validation-cache.ts",
  "../../collaboration-server/document.ts", "../../collaboration-server/persistence.ts",
  "../../lib/board/rich-text/codec.ts"], names: [], mappings: "AAAA;ACAA;ACAA;ACAA" };

function frame(functionName: string, lineNumber: number, url = bundle, columnNumber = 0) {
  return { functionName, lineNumber, columnNumber, url, scriptId: "1" };
}

function profile(stacks: { frames: ReturnType<typeof frame>[]; micros: number }[]) {
  const nodes = [{ id: 1, callFrame: frame("(root)", -1, "", -1), children: [] as number[] }];
  const samples: number[] = [], timeDeltas: number[] = [];
  for (const stack of stacks) {
    let parent = nodes[0];
    for (const callFrame of stack.frames) {
      const node = { id: nodes.length + 1, callFrame, children: [] as number[] };
      parent.children.push(node.id); nodes.push(node); parent = node;
    }
    samples.push(parent.id); timeDeltas.push(stack.micros);
  }
  return { nodes, samples, timeDeltas };
}

function encodingStack(caller: ReturnType<typeof frame>[]) {
  return [...caller, frame("encodeStateAsUpdate", 100, yjs), frame("writeStructs", 200, yjs)];
}

function bundledProfile() {
  return profile([
    { frames: encodingStack([frame("persist", 2), frame("validateDocument", 1)]), micros: 10_000 },
    { frames: encodingStack([frame("validate", 0)]), micros: 20_000 },
    { frames: encodingStack([frame("validate", 0), frame("validateShadowUpdate", 1), frame("validateDocument", 1)]), micros: 30_000 },
  ]);
}

describe("CPU profile attribution for the native collaboration bundle", () => {
  it("maps bundled persistence and alignment callers without changing raw frames or totals", () => {
    const input = bundledProfile(), before = JSON.stringify(input);
    const result = summarizeCpuProfile(input, { sourceMap });
    expect(result.inclusive.persist).toMatchObject({ ms: 10, activePercent: 16.67 });
    expect(result.encodingCallers).toMatchObject({ persistence: { ms: 10 }, canonicalAlignment: { ms: 20 },
      validatedShadow: { ms: 30 }, other: { ms: 0 }, unresolved: { ms: 0 } });
    expect(result.sourceMapping).toMatchObject({ status: "complete", mappedFrames: 6, unmappedFrames: 0 });
    expect(result.sourceMapping.mapSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(result.inclusive.yjsEncoding.ms).toBe(60);
    expect(result.activeMs).toBe(60);
    expect(JSON.stringify(input)).toBe(before);
  });

  it("does not report unconditional zero callers when the bundle map is unavailable", () => {
    const result = summarizeCpuProfile(bundledProfile());
    expect(result.sourceMapping.status).toBe("unavailable");
    expect(result.inclusive.persist).toMatchObject({ ms: null, activePercent: null, observedMs: 0 });
    expect(result.encodingCallers.canonicalAlignment).toMatchObject({ ms: null, observedMs: 0 });
    expect(result.encodingCallers.persistence.ms).toBeNull();
    expect(result.encodingCallers.unresolved.ms).toBe(60);
    expect(result.inclusive.yjsEncoding.ms).toBe(60);
  });

  it("rejects findEntry fallback to a preceding generated line and retains a measured lower bound", () => {
    const result = summarizeCpuProfile(bundledProfile(), { sourceMap: { ...sourceMap, mappings: "AAAA" } });
    expect(result.sourceMapping).toMatchObject({ status: "partial", mappedFrames: 2, unmappedFrames: 4 });
    expect(result.encodingCallers.canonicalAlignment).toMatchObject({ ms: null, observedMs: 20 });
    expect(result.encodingCallers.unresolved.ms).toBe(40);
    expect(result.inclusive.persist.ms).toBeNull();
  });

  it.each([-1, 0.5, Number.NaN])("requires valid zero-based frame positions (%s)", (position) => {
    const result = summarizeCpuProfile(profile([{ frames: encodingStack([frame("validate", position)]), micros: 1_000 }]), { sourceMap });
    expect(result.sourceMapping.unmappedFrames).toBe(1);
    expect(result.encodingCallers.unresolved.ms).toBe(1);
    const badColumn = summarizeCpuProfile(profile([{ frames: encodingStack([frame("validate", 0, bundle, position)]), micros: 1_000 }]), { sourceMap });
    expect(badColumn.sourceMapping.unmappedFrames).toBe(1);
  });

  it("never applies the selected map to a different bundle URL", () => {
    const result = summarizeCpuProfile(profile([{ frames: encodingStack([
      frame("validate", 0, "file:///foreign/dist/collaboration/index.mjs"),
    ]), micros: 1_000 }]), { sourceMap });
    expect(result.sourceMapping).toMatchObject({ status: "unavailable", mappedFrames: 0, unmappedFrames: 1 });
    expect(result.encodingCallers.unresolved.ms).toBe(1);
  });

  it("degrades an invalid map to explicit unknown attribution", () => {
    const result = summarizeCpuProfile(bundledProfile(), { sourceMap: { version: 2, sources: [], names: [], mappings: "" } });
    expect(result.sourceMapping).toMatchObject({ status: "unavailable", reason: "source-map-invalid" });
    expect(result.encodingCallers.persistence.ms).toBeNull();
  });

  it("uses the nearest recognized caller and preserves unbundled source classification", () => {
    const input = profile([{ frames: encodingStack([
      frame("persist", 0, "file:///source/collaboration-server/persistence.ts"),
      frame("validate", 0, "file:///source/collaboration-server/validation-cache.ts"),
    ]), micros: 4_000 }, { frames: [frame("(garbage collector)", -1, "", -1)], micros: 1_000 }]);
    const result = summarizeCpuProfile(input);
    expect(result.sourceMapping.status).toBe("not-needed");
    expect(result.encodingCallers.canonicalAlignment.ms).toBe(4);
    expect(result.encodingCallers.persistence.ms).toBe(0);
    expect(result.inclusive.persist.ms).toBe(4);
    expect(result.inclusive.garbageCollection.ms).toBe(1);
    expect(result.inclusive.yjsEncoding.activePercent).toBe(80);
  });
});
