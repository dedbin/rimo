import * as Y from "yjs";
import { MAX_RICH_TEXT_LENGTH, MAX_RICH_TEXT_NODES, RichTextValidationError } from "./types";
import { textFragmentName } from "./document";

export const POSITION_MIGRATION_PREFIX = "__tiptap_position_migrations:root:";
export const MAX_POSITION_MIGRATION_RECORDS = 2000;
export const MAX_POSITION_MIGRATION_TRANSFERS = 20_000;
export const MAX_POSITION_MIGRATION_CAUSAL_ENTRIES = 20_000;
const MAX_SEEN_PER_RECORD = 2000;
const MAX_POSITION_SPAN = MAX_RICH_TEXT_LENGTH + MAX_RICH_TEXT_NODES * 2;

export interface PositionMigrationStats {
  records: number;
  transfers: number;
  causalEntries: number;
}

function invalid(code = "shape"): never { throw new RichTextValidationError(`Некорректные данные совместного редактирования текста [position:${code}]`); }
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}
function integer(value: unknown, max = Number.MAX_SAFE_INTEGER): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= max;
}
function client(value: unknown): value is number { return integer(value, 0xffff_ffff); }
function keys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): void {
  if (required.some((key) => !Object.hasOwn(value, key)) || Object.keys(value).some((key) => !required.includes(key) && !optional.includes(key))) invalid("fields");
}
function boundary(value: unknown): boolean { return value === undefined || value === "start" || value === "end"; }
function identifier(value: unknown): boolean {
  if (!record(value)) return false;
  keys(value, ["client", "clock"]);
  return client(value.client) && integer(value.clock);
}

function validateTransfer(value: unknown, fragmentName: string): void {
  if (!record(value)) invalid();
  keys(value, ["source", "target"]);
  const source = value.source;
  if (!record(source)) invalid();
  keys(source, ["client", "clock", "length"], ["boundary"]);
  // Pinned y-tiptap mergePositionTransfers also coalesces adjacent node boundaries.
  if (!client(source.client) || !integer(source.clock) || !integer(source.length, MAX_POSITION_SPAN) || source.length === 0 ||
    !Number.isSafeInteger(source.clock + source.length) || !boundary(source.boundary)) invalid("source-range");
  const target = value.target;
  if (target === null) return;
  if (!record(target)) invalid();
  keys(target, ["client", "clock", "type"], ["tname", "assoc", "boundary"]);
  if (!client(target.client) || !integer(target.clock) || !Number.isSafeInteger(target.clock + source.length) ||
    !boundary(target.boundary) || (target.assoc !== undefined && ![-1, 0, 1].includes(target.assoc as number))) invalid("target-range");
  if (target.type === null) {
    // getPositionNodeTransfers targets node identities directly for start/end,
    // with type:null and no tname; other root targets require this exact fragment.
    if (target.boundary !== undefined && target.tname === undefined) return;
    if (target.tname !== fragmentName) invalid("target-root");
  } else if (!identifier(target.type) || target.tname !== undefined) invalid("target-type");
}

export function positionMigrationLayerId(name: string): string | null {
  return /^__tiptap_position_migrations:root:text:([a-zA-Z0-9_-]{1,128})$/.exec(name)?.[1] ?? null;
}

export function validatePositionMigrationRoot(doc: Y.Doc, name: string): PositionMigrationStats {
  const layerId = positionMigrationLayerId(name);
  if (!layerId || !doc.share.has(name)) invalid();
  const fragmentName = textFragmentName(layerId);
  if (!doc.share.has(fragmentName)) invalid();
  // Resolve root types through public Yjs methods. A conflicting shared type throws.
  try { doc.getXmlFragment(fragmentName); } catch { invalid(); }
  let store: Y.Map<unknown>;
  try { store = doc.getMap<unknown>(name); } catch { invalid(); }
  const stats: PositionMigrationStats = { records: store.size, transfers: 0, causalEntries: 0 };
  if (stats.records > MAX_POSITION_MIGRATION_RECORDS) invalid();
  for (const [key, value] of store) {
    if (!record(value)) invalid();
    keys(value, ["version", "client", "clock", "seen", "transfers"]);
    if (value.version !== 1 || !client(value.client) || !integer(value.clock) || key !== `${value.client}:${value.clock}` ||
      !Array.isArray(value.seen) || value.seen.length > MAX_SEEN_PER_RECORD || !Array.isArray(value.transfers)) invalid();
    stats.transfers += value.transfers.length;
    stats.causalEntries += value.seen.length;
    if (stats.transfers > MAX_POSITION_MIGRATION_TRANSFERS || stats.causalEntries > MAX_POSITION_MIGRATION_CAUSAL_ENTRIES) invalid();
    const seenClients = new Set<number>();
    for (const item of value.seen) {
      if (!Array.isArray(item) || item.length !== 2 || !client(item[0]) || !integer(item[1]) || seenClients.has(item[0])) invalid();
      seenClients.add(item[0]);
    }
    for (const transfer of value.transfers) validateTransfer(transfer, fragmentName);
  }
  return stats;
}
