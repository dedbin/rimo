import { randomUUID } from "node:crypto";

import { SERVICES } from "../scripts/monitor-common.mjs";

import type { FixtureCommand, FixtureContext } from "./restic-compose-roundtrip";

type Health = "healthy" | "warning" | "critical";
interface MonitorCheck { status: Health; reasonCodes: string[]; data?: unknown }
interface MonitorBody { version: number; project: string; status: Health; reasonCodes: string[]; checks: Record<string, MonitorCheck> }
export interface MonitorObservation {
  stage: string; exitCode: number; status: Health; reasonCodes: string[]; passed: boolean; syntheticLogInjection: boolean;
  checks: Record<string, Pick<MonitorCheck, "status" | "reasonCodes">>;
  owners: number | null;
  acl: Record<string, number> | null;
}
export interface MonitorEvidence { stage?: string; observations: MonitorObservation[] }

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function codes(value: unknown): value is string[] {
  return Array.isArray(value) && value.length <= 64 && value.every(item => typeof item === "string" && /^[A-Z0-9_]{1,96}$/.test(item));
}
function health(value: unknown): value is Health { return value === "healthy" || value === "warning" || value === "critical"; }

export async function acceptanceMetadata(context: FixtureContext, command: FixtureCommand, signal: AbortSignal): Promise<{
  dockerServer: string; dockerCompose: string; postgres: string; images: Record<string, string>;
}> {
  const capture = async (args: string[]): Promise<string> => {
    const result = await command("docker", args, context.environment, undefined, { signal, timeoutMs: 15_000 });
    if (result.code !== 0) throw new Error("ACCEPTANCE_METADATA_UNAVAILABLE");
    return result.stdout.trim();
  };
  const dockerServer = JSON.parse(await capture(["version", "--format", "{{json .Server.Version}}"]));
  const dockerCompose = await capture(["compose", "version", "--short"]);
  if (typeof dockerServer !== "string" || !/^[\w.+-]{1,80}$/.test(dockerServer) || !/^[\w.+-]{1,80}$/.test(dockerCompose)) throw new Error("ACCEPTANCE_VERSION_INVALID");
  const postgres = /\b(\d+\.\d+(?:\.\d+)?)\b/.exec(await capture([...context.args, "exec", "-T", "db", "postgres", "--version"]))?.[1];
  if (!postgres) throw new Error("ACCEPTANCE_POSTGRES_VERSION_INVALID");
  const ids = (await capture([...context.args, "ps", "--all", "--quiet", ...SERVICES])).split(/\s+/);
  if (ids.length !== SERVICES.length || !ids.every(id => /^[a-f0-9]{64}$/.test(id))) throw new Error("ACCEPTANCE_CONTAINER_INVENTORY_INVALID");
  const format = '{"project":{{json (index .Config.Labels "com.docker.compose.project")}},"service":{{json (index .Config.Labels "com.docker.compose.service")}},"image":{{json .Image}}}';
  const rows = (await capture(["inspect", "--type", "container", "--format", format, ...ids])).split(/\r?\n/).map(line => JSON.parse(line));
  const project = context.args[context.args.indexOf("--project-name") + 1];
  const images: Record<string, string> = {};
  for (const row of rows) {
    if (row.project !== project || !SERVICES.includes(row.service) || images[row.service] || !/^sha256:[a-f0-9]{64}$/.test(row.image)) throw new Error("ACCEPTANCE_IMAGE_BINDING_INVALID");
    images[row.service] = row.image;
  }
  if (Object.keys(images).length !== SERVICES.length) throw new Error("ACCEPTANCE_IMAGE_BINDING_INVALID");
  return { dockerServer, dockerCompose, postgres, images };
}

const QUOTA_FIXTURE = String.raw`const deadline=setTimeout(()=>process.exit(124),15000);deadline.unref();
import dbModule from './server/db.ts';
const chunks=[];for await(const chunk of process.stdin)chunks.push(chunk);
const {ids,remove}=JSON.parse(Buffer.concat(chunks).toString('utf8'));
if(!Array.isArray(ids)||ids.length!==5||!ids.every(id=>/^[a-f0-9-]{36}$/.test(id)))throw new Error('FIXTURE_IDS_INVALID');
const pool=dbModule.getPool();
try {
 if(remove)await pool.query('DELETE FROM "user" WHERE id=ANY($1::text[])',[ids]);
 else await pool.query('INSERT INTO "user"(id,name,email,"isAnonymous") SELECT id,$2,email,false FROM unnest($1::text[],$3::text[]) AS users(id,email)',[ids,'Monitor quota fixture',ids.map(id=>id+'@example.test')]);
}finally{await pool.end();}`;
const LOG_FIXTURE = String.raw`const deadline=setTimeout(()=>process.exit(124),5000);deadline.unref();
import {writeFile} from 'node:fs/promises';
const chunks=[];for await(const chunk of process.stdin)chunks.push(chunk);
const {kind}=JSON.parse(Buffer.concat(chunks).toString('utf8'));
if(!['denied','timeout'].includes(kind))throw new Error('FIXTURE_KIND_INVALID');
await writeFile('/proc/1/fd/2',JSON.stringify({event:'collaboration_access_check_failed',kind,elapsedMs:kind==='timeout'?3001:1})+'\n');`;
const WORKER_READY = String.raw`const deadline=setTimeout(()=>process.exit(124),15000);deadline.unref();
const end=Date.now()+12000;
for(;;){
 try{const response=await fetch('http://127.0.0.1:3100/healthz',{signal:AbortSignal.timeout(2000)});if(response.ok)break;}catch{}
 if(Date.now()>end)throw new Error('PDF_NOT_READY');
 await new Promise(resolve=>setTimeout(resolve,200));
}`;

export async function monitorComposeChecks(options: {
  context: FixtureContext; command: FixtureCommand; project: string; envFile: string; composeFile: string;
  signal: AbortSignal; evidence: MonitorEvidence;
}): Promise<void> {
  const { context, command, project, envFile, composeFile, signal, evidence } = options;
  if (!/^rimo-backup-src-[a-f0-9]{8}$/.test(project)) throw new Error("MONITOR_FIXTURE_PROJECT_INVALID");
  const probe = async (stage: string, expected: Health | readonly Health[], validate: (body: MonitorBody) => boolean = () => true, syntheticLogInjection = false): Promise<MonitorBody> => {
    evidence.stage = stage;
    const result = await command(process.execPath, ["scripts/monitor-service.mjs", "--project", project, "--env-file", envFile,
      "--compose-file", composeFile], process.env, undefined, { signal, timeoutMs: 50_000 });
    const body = JSON.parse(result.stdout) as MonitorBody;
    if (body.version !== 1 || body.project !== project || !health(body.status) || !codes(body.reasonCodes) ||
        result.code !== ["healthy", "warning", "critical"].indexOf(body.status)) throw new Error("MONITOR_FIXTURE_REPORT_INVALID");
    const checks: MonitorObservation["checks"] = {};
    for (const name of ["containers", "application", "postgresFilesystems", "pdfQueue", "collaborationEvents"]) {
      const check = body.checks?.[name];
      if (!check || !health(check.status) || !codes(check.reasonCodes)) throw new Error("MONITOR_FIXTURE_CHECK_INVALID");
      checks[name] = { status: check.status, reasonCodes: check.reasonCodes };
    }
    const owners = record(record(body.checks.application.data).usage).owners;
    const rawAcl = record(record(body.checks.collaborationEvents.data).acl);
    const acl = Object.fromEntries(["timeout", "dependencyError", "denied", "editorLimit"].map(key => [key, rawAcl[key]]));
    const validAcl = Object.values(acl).every(value => Number.isSafeInteger(value) && Number(value) >= 0);
    const passed = (Array.isArray(expected) ? expected.includes(body.status) : body.status === expected) && validate(body);
    evidence.observations.push({ stage, exitCode: result.code, status: body.status, reasonCodes: body.reasonCodes, passed,
      syntheticLogInjection, checks, owners: Number.isSafeInteger(owners) && Number(owners) >= 0 ? Number(owners) : null,
      acl: validAcl ? acl as Record<string, number> : null });
    if (!passed) throw new Error("MONITOR_FIXTURE_EXPECTATION_FAILED");
    return body;
  };
  const node = async (service: string, script: string, input: unknown, cleanup = false): Promise<void> => {
    const result = await command("docker", [...context.args, "exec", "-T", service, "node", "--import=tsx", "--input-type=module", "-e", script], context.environment, JSON.stringify(input),
    { signal: cleanup ? undefined : signal, timeoutMs: 20_000 });
    if (result.code !== 0) throw new Error("MONITOR_FIXTURE_NODE_FAILED");
  };
  await probe("baseline", "healthy");
  try {
    evidence.stage = "stop-pdf-worker";
    await context.run(["stop", "--timeout", "5", "export-worker"]);
    await probe("pdf-worker-stopped", "critical", body => body.checks.pdfQueue.reasonCodes.includes("PDF_CONTAINER_UNAVAILABLE"));
  } finally { if (!signal.aborted) await context.run(["up", "--detach", "--no-build", "--wait", "--wait-timeout", "60", "export-worker"]); }
  await context.run(["exec", "-T", "export-worker", "node", "--input-type=module", "-e", WORKER_READY]);
  await probe("pdf-worker-recovered", "healthy");
  try {
    evidence.stage = "stop-database";
    await context.run(["stop", "--timeout", "5", "db"]);
    await probe("database-stopped", "critical", body => body.checks.postgresFilesystems.reasonCodes.includes("POSTGRES_CONTAINER_UNAVAILABLE"));
  } finally { if (!signal.aborted) await context.run(["up", "--detach", "--no-build", "--wait", "--wait-timeout", "120", "db", "app", "collaboration"]); }
  // An automatic restart is an honest warning; availability must still recover.
  const recovered = await probe("database-recovered", ["healthy", "warning"], body =>
    ["application", "postgresFilesystems", "pdfQueue", "collaborationEvents"].every(name => body.checks[name].status === "healthy") &&
    body.reasonCodes.every(code => code === "CONTAINER_RESTARTED"));
  const ids = Array.from({ length: 5 }, () => randomUUID());
  try {
    evidence.stage = "insert-quota-fixture";
    await node("app", QUOTA_FIXTURE, { ids, remove: false });
    await probe("six-owner-quota", "warning", body => body.checks.application.reasonCodes.includes("OWNERS_LIMIT_REACHED") &&
      record(record(body.checks.application.data).usage).owners === 6);
  } finally { await node("app", QUOTA_FIXTURE, { ids, remove: true }, true); }
  await probe("quota-fixture-removed", recovered.status, body => record(record(body.checks.application.data).usage).owners === 1 &&
    body.reasonCodes.every(code => code === "CONTAINER_RESTARTED"));
  evidence.stage = "inject-synthetic-denied-log";
  await node("collaboration", LOG_FIXTURE, { kind: "denied" });
  await probe("synthetic-denied-log", recovered.status, body => body.checks.collaborationEvents.status === "healthy" &&
    body.reasonCodes.every(code => code === "CONTAINER_RESTARTED") && Number(record(record(body.checks.collaborationEvents.data).acl).denied) >= 1, true);
  evidence.stage = "inject-synthetic-timeout-log";
  await node("collaboration", LOG_FIXTURE, { kind: "timeout" });
  await probe("synthetic-timeout-log", "critical", body => body.checks.collaborationEvents.reasonCodes.includes("COLLABORATION_ACL_CHECK_FAILURE") &&
    Number(record(record(body.checks.collaborationEvents.data).acl).timeout) >= 1, true);
  evidence.stage = "verified";
}
