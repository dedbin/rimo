import { constants } from "node:fs";
import type { BigIntStats } from "node:fs";
import { access, lstat, opendir, realpath, statfs, unlink } from "node:fs/promises";
import path from "node:path";

export const MIN_ORPHAN_AGE_MS = 24 * 60 * 60 * 1000;
export const OWNED_ASSET_NAME = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(webp|png|jpeg|gif)$/;
const NANOSECONDS_PER_MS = BigInt(1_000_000);

export class OperationsError extends Error {
  constructor(readonly code: string, readonly removed = false) { super(code); }
}

export interface StorageRoot { readonly absolutePath: string; readonly device: bigint; readonly inode: bigint }
export interface OrphanCandidate { readonly key: string; readonly identity: BigIntStats }
export interface StorageMetrics {
  readonly readable: boolean; readonly writable: boolean;
  readonly freeBytes: number; readonly totalBytes: number;
  readonly regularFileCount: number; readonly fileBytes: number;
  readonly skippedDirectories: number; readonly skippedLinks: number;
}

function samePath(left: string, right: string): boolean {
  return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
}
export function safeNumber(value: bigint | string): number {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < 0) throw new OperationsError("METRICS_OUT_OF_RANGE");
  return result;
}
function missing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

export async function openStorageRoot(directory: string): Promise<StorageRoot> {
  if (!path.isAbsolute(directory)) throw new OperationsError("STORAGE_ROOT_INVALID");
  const absolutePath = path.resolve(directory);
  if (samePath(absolutePath, path.parse(absolutePath).root)) throw new OperationsError("STORAGE_ROOT_INVALID");
  const identity = await lstat(absolutePath, { bigint: true });
  if (!identity.isDirectory() || identity.isSymbolicLink() || !samePath(await realpath(absolutePath), absolutePath)) {
    throw new OperationsError("STORAGE_ROOT_UNSAFE");
  }
  return { absolutePath, device: identity.dev, inode: identity.ino };
}

export async function assertStorageRoot(root: StorageRoot): Promise<void> {
  const current = await openStorageRoot(root.absolutePath);
  if (current.device !== root.device || current.inode !== root.inode) throw new OperationsError("STORAGE_ROOT_CHANGED");
}

export async function* storageEntries(root: StorageRoot): AsyncGenerator<{ readonly key: string; readonly identity: BigIntStats }> {
  await assertStorageRoot(root);
  const directory = await opendir(root.absolutePath);
  for await (const entry of directory) {
    try { yield { key: entry.name, identity: await lstat(path.join(root.absolutePath, entry.name), { bigint: true }) }; }
    catch (error) { if (!missing(error)) throw error; }
  }
}

export function isOldOwnedFile(key: string, identity: BigIntStats, cutoff: number): boolean {
  return OWNED_ASSET_NAME.test(key) && identity.isFile() && !identity.isSymbolicLink() && identity.nlink === BigInt(1) &&
    identity.mtimeNs <= BigInt(cutoff) * NANOSECONDS_PER_MS && identity.ctimeNs <= BigInt(cutoff) * NANOSECONDS_PER_MS;
}

export async function removeUnchangedFile(root: StorageRoot, candidate: OrphanCandidate, cutoff: number): Promise<boolean> {
  if (!OWNED_ASSET_NAME.test(candidate.key)) throw new OperationsError("STORAGE_FILE_INVALID");
  await assertStorageRoot(root);
  const filename = path.join(root.absolutePath, candidate.key);
  let current: BigIntStats;
  try { current = await lstat(filename, { bigint: true }); }
  catch (error) { if (missing(error)) return false; throw error; }
  const previous = candidate.identity;
  if (!isOldOwnedFile(candidate.key, current, cutoff) ||
      current.dev !== previous.dev || current.ino !== previous.ino || current.size !== previous.size ||
      current.mtimeNs !== previous.mtimeNs || current.ctimeNs !== previous.ctimeNs || current.nlink !== previous.nlink) return false;
  await assertStorageRoot(root);
  // Only a validated basename is used; no recursion or symlink target is followed.
  await unlink(filename);
  return true;
}

export async function inspectStorage(directory: string): Promise<StorageMetrics> {
  const root = await openStorageRoot(directory);
  const [readable, writable, space] = await Promise.all([
    access(root.absolutePath, constants.R_OK).then(() => true, () => false),
    access(root.absolutePath, constants.W_OK).then(() => true, () => false),
    statfs(root.absolutePath, { bigint: true }),
  ]);
  let regularFileCount = 0; let bytes = BigInt(0); let skippedDirectories = 0; let skippedLinks = 0;
  for await (const { identity } of storageEntries(root)) {
    if (identity.isSymbolicLink()) skippedLinks += 1;
    else if (identity.isDirectory()) skippedDirectories += 1;
    else if (identity.isFile()) { regularFileCount += 1; bytes += identity.size; }
  }
  await assertStorageRoot(root);
  return { readable, writable, freeBytes: safeNumber(space.bavail * space.bsize), totalBytes: safeNumber(space.blocks * space.bsize),
    regularFileCount, fileBytes: safeNumber(bytes), skippedDirectories, skippedLinks };
}
