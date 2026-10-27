// @vitest-environment node
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

import { acceptanceStatus, clockBounds, criteria, overlapEvidence } from "../scripts/performance/pdf-lesson/criteria.mjs";
import { reservePdfDirectory } from "../scripts/performance/pdf-lesson/artifacts.mjs";
import { validateProjectBindings } from "../scripts/performance/service-target.mjs";

const execute = promisify(execFile);
interface ProjectContainer {
  id: string; imageId: string; project: string; service: string;
  ports: Record<string, { HostIp: string; HostPort: string }[]>;
}
function projectInventory(hostIp = "127.0.0.1"): ProjectContainer[] {
  return [{ id: "a".repeat(64), imageId: `sha256:${"c".repeat(64)}`, project: "fixture", service: "caddy",
    ports: { "80/tcp": [{ HostIp: hostIp, HostPort: "3080" }] } },
  { id: "b".repeat(64), imageId: `sha256:${"d".repeat(64)}`, project: "fixture", service: "export-worker", ports: {} }];
}
function completeReport() {
  const helper = { image: "fixture-image", helperConfigurationSha256: "fixture-hash", perDirectionBitsPerSecond: 50_000_000 };
  const verified = { pages: 20, russian_text_searchable: true, russian_text_copyable: true, page_order_verified: true, independent_pdfminer_exact_phrases: true };
  const memory = { cgroupCurrentBytes: 100_000_000, cgroupLimitBytes: 768 * 1024 * 1024, pid1RssBytes: 50_000_000 };
  return { requestedExports: 20, snapshot: { revision: 42 }, operations: Array.from({ length: 20 }, (_, index) => ({
    source: index % 2 ? "editor" : "owner", overlap: { fromEpochMs: 1, toEpochMs: 2 }, saved: true, undoRestored: true,
    browserClockDifferenceMs: 0, peerClockDifferenceMs: 0,
    pdf: { revision: 42, requestDurationMs: 1_000, verified: { ...verified } },
  })), fullPropagation: { count: 20, p95: 150 }, overlapPropagation: { count: 20, p95: 150 }, roundtrip: { count: 20, p50: 110 },
    calibration: { status: "complete", checks: { http: true, ws: true, download: true, upload: true }, helper }, helpers: [{ ...helper }, { ...helper }],
    probe: { clock: { stable: true, uncertaintyMs: 4 }, samples: [{ ok: true, waiting: 0, atEpochMs: 1_000, monotonicMs: 100 }] }, pageErrors: [],
    durable: { originalCoordinatesRestored: true, controlContentRestored: true, persisted: true },
    memoryBefore: memory, memoryImmediateAfter: memory, memoryAfterFiveSecondIdle: memory };
}

describe("PDF parallel lesson acceptance boundary", () => {
  it.each(["127.0.0.1", "0.0.0.0", "::1", "::"])("binds the probe worker to the project serving3080 on %s", (hostIp) => {
    const binding = validateProjectBindings(projectInventory(hostIp), "fixture");
    expect(binding.project).toBe("fixture");
    expect(binding.caddy.browserBindings).toEqual([{ containerPort: "80/tcp", hostIp, hostPort: "3080" }]);
    expect(binding.worker.id).toBe("b".repeat(64));
    expect(binding.worker.imageId).toBe(`sha256:${"d".repeat(64)}`);
  });

  it.each(["wrong-project", "no-3080", "external-bind", "udp-only", "duplicate-caddy", "duplicate-worker", "missing-worker"])(
    "rejects project occupancy unrelated to the browser origin: %s", (invalid) => {
      const inventory = projectInventory(invalid === "external-bind" ? "192.0.2.10" : "127.0.0.1");
      if (invalid === "no-3080") inventory[0].ports["80/tcp"][0].HostPort = "3081";
      if (invalid === "udp-only") { inventory[0].ports["80/udp"] = inventory[0].ports["80/tcp"]; delete inventory[0].ports["80/tcp"]; }
      if (invalid === "duplicate-caddy") inventory.push({ ...inventory[0] });
      if (invalid === "duplicate-worker") inventory.push({ ...inventory[1] });
      if (invalid === "missing-worker") inventory.pop();
      expect(() => validateProjectBindings(inventory, invalid === "wrong-project" ? "other-project" : "fixture")).toThrow();
    });

  it("keeps PDFs from two explicit output files in one parent in independently reserved directories", async () => {
    const root = path.resolve("temp");
    const parent = await mkdtemp(path.join(root, "pdf-lesson-artifact-test-"));
    try {
      const first = await reservePdfDirectory(path.join(parent, "first.json"));
      const firstPdf = path.join(first, "control-001.pdf");
      await writeFile(firstPdf, "%PDF-first-run-evidence", { flag: "wx" });
      const second = await reservePdfDirectory(path.join(parent, "second.json"));
      await writeFile(path.join(second, "control-001.pdf"), "%PDF-second-run-evidence", { flag: "wx" });
      expect(first).not.toBe(second);
      expect(path.dirname(first)).toBe(parent);
      expect(path.dirname(second)).toBe(parent);
      expect(path.basename(first)).toMatch(/^pdf-[a-f0-9-]{36}$/);
      expect(await readFile(firstPdf, "utf8")).toBe("%PDF-first-run-evidence");
      expect(await readFile(path.join(second, "control-001.pdf"), "utf8")).toBe("%PDF-second-run-evidence");
    } finally {
      if (path.dirname(parent) !== root) throw new Error("Unexpected PDF lesson test directory");
      await rm(parent, { recursive: true, force: true });
    }
  });

  it("requires every criterion and preserves the complete operation set", () => {
    const report = completeReport();
    const before = structuredClone(report);
    expect(acceptanceStatus(criteria(report), [])).toBe("accepted");
    expect(report).toEqual(before);
    report.operations[0].overlap = null as never;
    report.overlapPropagation.count = 19;
    expect(acceptanceStatus(criteria(report), [])).toBe("not-accepted");
    expect(report.operations).toHaveLength(20);
  });

  it.each(["pages", "revision", "saved", "undo", "p95", "roundtrip", "calibration", "queue", "clock", "memory", "owner-only", "incomplete"])(
    "cannot accept a run missing %s", (missing) => {
      const report = completeReport();
      if (missing === "pages") report.operations[0].pdf.verified.pages = 19;
      if (missing === "revision") report.operations[0].pdf.revision = 43;
      if (missing === "saved") report.operations[0].saved = false;
      if (missing === "undo") report.operations[0].undoRestored = false;
      if (missing === "p95") report.overlapPropagation.p95 = 301;
      if (missing === "roundtrip") report.roundtrip.p50 = 10;
      if (missing === "calibration") report.calibration.checks.upload = false;
      if (missing === "queue") report.probe.samples[0].waiting = 1;
      if (missing === "clock") report.probe.clock.stable = false;
      if (missing === "memory") report.memoryImmediateAfter.cgroupCurrentBytes = 900 * 1024 * 1024;
      if (missing === "owner-only") report.operations.forEach((entry) => { entry.source = "owner"; });
      if (missing === "incomplete") report.operations.pop();
      expect(acceptanceStatus(criteria(report), [])).toBe("not-accepted");
    });

  it("never accepts runtime, interruption or cleanup failures", () => {
    const report = { ...completeReport(), error: "Operation failed", interruption: { reason: "SIGINT" } };
    expect(acceptanceStatus(criteria(report), [])).toBe("not-accepted");
    expect(acceptanceStatus(criteria(completeReport()), [{ status: "failed" }])).toBe("cleanup-failed");
  });

  it.each([31_000, Number.NaN, Number.POSITIVE_INFINITY, -1])("rejects a PDF duration outside the finite30-second budget: %s", (duration) => {
    const report = completeReport();
    report.operations[0].pdf.requestDurationMs = duration;
    const checks = criteria(report);
    expect(checks.allExportsWithin30Seconds).toBe(false);
    expect(acceptanceStatus(checks, [])).toBe("not-accepted");
  });

  it.each([0, 30_000])("accepts a PDF duration on the inclusive budget boundary: %s", (duration) => {
    const report = completeReport();
    report.operations[0].pdf.requestDurationMs = duration;
    expect(criteria(report).allExportsWithin30Seconds).toBe(true);
    expect(acceptanceStatus(criteria(report), [])).toBe("accepted");
  });

  it("confirms pointerup strictly inside observed occupancy with bounded worker/host clocks", () => {
    const bounds = clockBounds([{ sentAt: 1_100, receivedAt: 1_104, probeAt: 1_000 }, { sentAt: 1_200, receivedAt: 1_204, probeAt: 1_100 }]);
    const operation = { pointerUpAt: 1_150, browserClockDifferenceMs: 0, probeStartSequence: 0, probeEndSequence: 2,
      pdf: { requestStartEpochMs: 1_050, bodyEndEpochMs: 1_250 } };
    const samples = [{ sequence: 1, atEpochMs: 1_000, ok: true, running: true, waiting: 0 },
      { sequence: 2, atEpochMs: 1_100, ok: true, running: true, waiting: 0 }];
    expect(overlapEvidence(operation, samples, bounds)).toMatchObject({ firstSequence: 1, lastSequence: 2, pointerUpAt: 1_150 });
    expect(overlapEvidence({ ...operation, pointerUpAt: 1_100 }, samples, bounds)).toBeNull();
    expect(overlapEvidence(operation, samples.slice(0, 1), bounds)).toBeNull();
    expect(overlapEvidence(operation, samples.map((entry) => ({ ...entry, running: false })), bounds)).toBeNull();
    expect(overlapEvidence(operation, [{ ...samples[0], running: false }, samples[1]], bounds)).toBeNull();
    expect(overlapEvidence({ ...operation, browserClockDifferenceMs: 10 }, samples, bounds)).toBeNull();
    expect(overlapEvidence({ ...operation, pdf: { requestStartEpochMs: 1_050, bodyEndEpochMs: 1_100 } }, samples, bounds)).toBeNull();
    const drift = clockBounds([{ sentAt: 100, receivedAt: 102, probeAt: 0 }, { sentAt: 200, receivedAt: 202, probeAt: 200 }]);
    expect(drift.stable).toBe(false);
    expect(overlapEvidence(operation, samples, drift)).toBeNull();
  });

  it("validates the declared 3000/500 scene,20 frames and bounded control pages without any service/browser", async () => {
    const code = `
      import assert from 'node:assert/strict';
      import {createRequire} from 'node:module';
      const require=createRequire(import.meta.url);
      const {initializeDocument,validateDocument}=require('./collaboration-server/document.ts');
      const {DEFAULT_LIMITS}=require('./collaboration-server/types.ts');
      const {intersectsViewport}=require('./lib/board/geometry.ts');
      const {parseLayer}=require('./lib/board/model.ts');
      const {getRichTextJson}=require('./lib/board/rich-text/document.ts');
      const {pdfFixture}=require('./__tests__/pdf-fixtures.ts');
      const {parsePdfJob}=require('./export-worker/validation.ts');
      const {renderPdfHtml}=require('./export-worker/render.ts');
      import {Y} from './scripts/performance/common.mjs';
      import {VIEWPORT} from './scripts/performance/fixture.mjs';
      import {seedLesson,auditLesson} from './scripts/performance/pdf-lesson/fixture.mjs';
      const document=new Y.Doc();initializeDocument(document);
      try{
        const scene=seedLesson(document,'/api/assets/base-fixture','/api/assets/control-fixture');
        const state=validateDocument(document,DEFAULT_LIMITS);
        const visible=[...document.getMap('layers').values()].filter(value=>intersectsViewport(parseLayer(value.toJSON()),{x:0,y:0,scale:1},VIEWPORT)).length;
        assert.equal(visible,500);assert.equal(scene.summary.replacedOffscreenIds.length,7);assert.equal(scene.pages.length,20);
        assert.deepEqual(auditLesson(document,scene),{originalCoordinatesRestored:true,controlContentRestored:true});
        const control=pdfFixture(20);
        const controlLayers=scene.summary.replacedOffscreenIds.map(id=>{const layer=document.getMap('layers').get(id).toJSON();
          return {id,layer,...([2,3].includes(layer.type)?{richText:getRichTextJson(document,id)}:{})};});
        const pages=scene.pages.map(page=>{const frame=document.getMap('frames').get(page.source.frameId).toJSON();
          return {name:frame.name,bounds:frame,format:page.format,orientation:page.orientation,layerIds:scene.summary.replacedOffscreenIds};});
        const job=parsePdfJob({...control,layers:controlLayers,pages,assets:[{...control.assets[0],id:'control-fixture'}]});
        const htmlBytes=Buffer.byteLength(renderPdfHtml(job,''));
        assert(htmlBytes<48*1024*1024);assert(Buffer.byteLength(JSON.stringify(job))<28*1024*1024);
        process.stdout.write(JSON.stringify({objects:scene.summary.objects,visible,frames:scene.pages.length,stateBytes:state.length,htmlBytes}));
      }finally{document.destroy();}
    `;
    const result = await execute(process.execPath, ["--import=tsx", "--input-type=module", "--eval", code], { timeout: 10_000, windowsHide: true });
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toMatchObject({ objects: 3_000, visible: 500, frames: 20 });
  }, 15_000);

  it("requires explicit service opt-in before reading private state or starting Docker/browser work", async () => {
    await expect(execute(process.execPath, ["--import=tsx", "scripts/performance/pdf-lesson/run.mjs", "--storage-state", "does-not-exist"], {
      timeout: 10_000, windowsHide: true,
    })).rejects.toMatchObject({ stderr: expect.stringContaining("requires explicit --allow-service-test") });
  }, 15_000);

  it("parses the remote read-only probe program without starting it", async () => {
    const code = `
      import {spawnSync} from 'node:child_process';
      import {PROBE_SOURCE} from './scripts/performance/pdf-lesson/probe.mjs';
      const result=spawnSync(process.execPath,['--input-type=module','--check'],{input:PROBE_SOURCE,encoding:'utf8',windowsHide:true});
      if(result.status!==0) process.exit(1);
      process.stdout.write(JSON.stringify({syntaxValid:true,noEnvironmentRead:!PROBE_SOURCE.includes('process.env')}));
    `;
    const result = await execute(process.execPath, ["--import=tsx", "--input-type=module", "--eval", code], { timeout: 10_000, windowsHide: true });
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toEqual({ syntaxValid: true, noEnvironmentRead: true });
  }, 15_000);
});
