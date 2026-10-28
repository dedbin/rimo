export const ASSET_DISK_FAILURE = String.raw`
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { open, readFile, readdir, stat, statfs, unlink } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import assetsModule from './server/assets.ts';
import authModule from './server/auth.ts';
import boardsModule from './server/boards.ts';
import dbModule from './server/db.ts';
import migrationsModule from './server/migrations.ts';

const deadline = setTimeout(() => process.exit(124), 45_000);
const pool = dbModule.getPool();
const storage = '/app/data/assets';
const filler = path.join(storage, '.resource-filler');
const origin = process.env.BETTER_AUTH_URL;
const base = 'http://127.0.0.1:3000';
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const request = (url, options = {}) => fetch(base + url, { ...options, signal: AbortSignal.timeout(5_000) });

async function waitForApp() {
  const until = Date.now() + 20_000;
  while (Date.now() < until) {
    const response = await request('/api/health').catch(() => null);
    if (response?.status === 200) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('Isolated app did not become healthy');
}

async function fillAssets() {
  const fs = await statfs(storage);
  assert.equal(fs.type, 0x01021994, 'Filler is restricted to Linux tmpfs');
  assert.equal(fs.bsize * fs.blocks, 1_048_576, 'Unexpected assets filesystem size');
  const handle = await open(filler, 'wx', 0o600);
  let written = 0;
  let code;
  try {
    const chunk = Buffer.alloc(65_536, 0xa5);
    while (written <= 1_048_576) written += (await handle.write(chunk)).bytesWritten;
  } catch (error) {
    code = error.code;
  } finally {
    await handle.close();
  }
  assert.equal(code, 'ENOSPC', 'Filler did not reach a real disk-full error');
  assert.equal((await statfs(storage)).bavail, 0, 'Assets tmpfs still has writable blocks');
  return written;
}

async function main() {
  assert.equal(process.env.ASSET_STORAGE_PATH, storage, 'Unexpected asset storage boundary');
  await migrationsModule.runMigrations();
  await waitForApp();
  const password = randomBytes(24).toString('base64url');
  const email = 'resource-' + randomBytes(12).toString('hex') + '@example.test';
  const owner = await authModule.createOwnerAccount({ name: 'Resource test owner', email, password });
  await pool.query('UPDATE "user" SET "emailVerified"=true,"registrationPending"=false WHERE id=$1', [owner.user.id]);
  const board = await boardsModule.createBoard(owner.user.id, 'Assets tmpfs failure');
  const login = await request('/api/auth/sign-in/email', {
    method: 'POST', headers: { origin, 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  assert.equal(login.status, 200, 'Isolated owner login failed');
  const cookie = login.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
  assert.ok(cookie, 'Owner login did not issue a cookie');
  const pixels = Buffer.alloc(64 * 48 * 3);
  for (let index = 0; index < pixels.length; index += 1) pixels[index] = (index * 17) % 251;
  const image = await sharp(pixels, { raw: { width: 64, height: 48, channels: 3 } }).png().toBuffer();
  const normalized = await assetsModule.normalizeImage(image);
  const filledBytes = await fillAssets();
  let failure;
  let failureStatus;
  let failureMessage;
  let uploadSucceeded = false;
  try {
    await assetsModule.uploadAsset(board.id, owner.user.id, image);
    uploadSucceeded = true;
  } catch (error) {
    failure = error.code;
    failureStatus = error.status;
    failureMessage = error.message;
  }
  assert.equal(uploadSucceeded, false, 'Disk-full source upload returned success');
  assert.equal(failure, 'STORAGE_FULL', 'Source upload failed for an unrelated reason');
  assert.equal(failureStatus, 507, 'Source upload did not report insufficient storage');
  assert.equal(typeof failureMessage, 'string');
  assert.ok(failureMessage.length > 0, 'Storage failure has no user-facing message');
  assert.doesNotMatch(failureMessage, /\/app\/|\/tmp\/|[a-f0-9-]{36}\.webp|ENOSPC|EDQUOT/);
  const form = new FormData();
  form.set('file', new File([image], 'valid.png', { type: 'image/png' }));
  const rejected = await request('/api/boards/' + board.id + '/assets', {
    method: 'POST', headers: { cookie, origin }, body: form,
  });
  assert.equal(rejected.status, 507, 'Disk-full HTTP upload did not report insufficient storage');
  const rejection = await rejected.json();
  assert.equal(rejection.error?.code, 'STORAGE_FULL');
  assert.equal(rejection.error?.message, failureMessage, 'Source and HTTP failure messages differ');
  assert.equal(rejection.asset, undefined, 'Failed HTTP upload returned an asset');
  const absent = await pool.query('SELECT count(*)::int AS count FROM assets WHERE board_id=$1', [board.id]);
  assert.equal(absent.rows[0].count, 0, 'Failed upload created a database asset row');
  const orphanFiles = [];
  for (const name of await readdir(storage)) {
    if (name === '.resource-filler') continue;
    assert.match(name, /^[a-f0-9-]{36}\.webp$/, 'Unexpected file in isolated asset storage');
    const denied = await request('/api/assets/' + name.slice(0, -5), { headers: { cookie } });
    assert.equal(denied.status, 404, 'Uncommitted asset became readable');
    orphanFiles.push({ bytes: (await stat(path.join(storage, name))).size });
  }
  assert.equal((await request('/api/health')).status, 200, 'App failed while assets tmpfs was full');
  await unlink(filler);
  const retryForm = new FormData();
  retryForm.set('file', new File([image], 'valid.png', { type: 'image/png' }));
  const retried = await request('/api/boards/' + board.id + '/assets', {
    method: 'POST', headers: { cookie, origin }, body: retryForm,
  });
  assert.equal(retried.status, 201, 'HTTP upload did not recover after freeing assets tmpfs');
  const accepted = (await retried.json()).asset;
  const deduplicated = await assetsModule.uploadAsset(board.id, owner.user.id, image);
  assert.equal(deduplicated.id, accepted.id, 'Recovered source upload did not deduplicate');
  const rows = await pool.query('SELECT * FROM assets WHERE board_id=$1', [board.id]);
  assert.equal(rows.rows.length, 1, 'Recovery produced unexpected asset rows');
  const row = rows.rows[0];
  assert.equal(row.id, accepted.id);
  assert.match(row.storage_key, /^[a-f0-9-]{36}\.webp$/);
  const stored = await readFile(path.join(storage, row.storage_key));
  assert.deepEqual(stored, normalized.data, 'Stored normalized bytes differ');
  assert.equal(row.sha256, hash(stored));
  assert.equal(Number(row.byte_size), stored.length);
  assert.equal(row.mime_type, 'image/webp');
  assert.equal(row.width, 64);
  assert.equal(row.height, 48);
  const decoded = await sharp(stored, { failOn: 'error' }).raw().toBuffer({ resolveWithObject: true });
  assert.equal(decoded.info.width, 64);
  assert.equal(decoded.info.height, 48);
  assert.ok(decoded.data.length >= 64 * 48 * 3, 'WebP decoding returned no pixel data');
  const downloaded = await assetsModule.downloadAsset(accepted.id, owner.user.id);
  assert.deepEqual(Buffer.from(await downloaded.arrayBuffer()), stored);
  const served = await request(accepted.url, { headers: { cookie } });
  assert.equal(served.status, 200);
  assert.equal(served.headers.get('content-type'), 'image/webp');
  assert.deepEqual(Buffer.from(await served.arrayBuffer()), stored, 'HTTP response bytes differ');
  assert.equal((await request('/api/health')).status, 200);
  process.stdout.write(JSON.stringify({
    fillerError: 'ENOSPC', filledBytes, sourceError: failure, sourceStatus: failureStatus,
    failedHttpStatus: rejected.status, failureMessageSafe: true,
    failedRows: absent.rows[0].count, orphanFiles, recoveredRows: rows.rows.length,
    recoveredHttpStatus: retried.status, decoded: true, downloaded: true,
    byteSize: stored.length, sha256: hash(stored), appHealthyWhileFull: true, appHealthyAfterRetry: true,
  }) + '\n');
}

try {
  await main();
} finally {
  await unlink(filler).catch(error => { if (error.code !== 'ENOENT') throw error; });
  await pool.end();
  clearTimeout(deadline);
}
`;
