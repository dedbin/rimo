export const POSTGRES_PERSISTENCE_FAILURE = String.raw`
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';
import { HocuspocusProvider, HocuspocusProviderWebsocket } from '@hocuspocus/provider';
import { Pool } from 'pg';
import WebSocket from '/tmp/pg-resource-ws/wrapper.mjs';
import * as Y from 'yjs';
import serverModule from './collaboration-server/server.ts';
import repositoryModule from './collaboration-server/postgres-repository.ts';
import migrationsModule from './server/migrations.ts';
import protocolModule from './lib/collaboration/protocol.ts';
import saveModule from './lib/collaboration/save-state.ts';

const deadline = setTimeout(() => process.exit(124), 90_000);
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4, connectionTimeoutMillis: 3_000, statement_timeout: 5_000 });
pool.on('error', () => undefined);
const input = createInterface({ input: process.stdin });
const commands = input[Symbol.asyncIterator]();
const origin = 'http://localhost:3000';
const boardId = randomUUID();
const ownerId = randomUUID();
const repository = repositoryModule.createPostgresRepository(pool);
const expected = new Map([['confirmed', 101]]);
const clients = [];
let server;
let phase = 'baseline';
const emit = (event) => process.stdout.write('RIMO_PG_EVENT ' + JSON.stringify(event) + '\n');
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');

async function waitFor(predicate, timeout = 15_000) {
  const until = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() > until) throw new Error('Collaboration condition deadline exceeded');
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

async function command(expectedCommand) {
  const next = await commands.next();
  assert.equal(next.done, false, 'Resource controller closed input too early');
  assert.equal(JSON.parse(next.value).command, expectedCommand, 'Unexpected resource controller command');
}

async function startServer() {
  const instance = serverModule.createCollaborationServer({
    origins: [origin], port: 0,
    limits: { persistenceDebounceMs: 25, persistenceMaxDebounceMs: 50 },
  }, {
    repository,
    async authenticate(_headers, requested) {
      if (requested !== boardId) return null;
      return { boardId, userId: ownerId, sessionId: ownerId, name: 'PG resource fixture', role: 'owner' };
    },
    async revalidate() { return 'owner'; },
  });
  await instance.listen();
  return instance;
}

async function connectClient() {
  const document = new Y.Doc();
  const messages = [];
  let failure = false;
  let destroyed = false;
  const socket = new HocuspocusProviderWebsocket({
    url: 'ws://127.0.0.1:' + server.address.port, autoConnect: false, maxAttempts: 1,
    jitter: false, initialDelay: 0,
    WebSocketPolyfill: class extends WebSocket {
      constructor(address) { super(address, { headers: { Origin: origin } }); }
    },
  });
  const provider = new HocuspocusProvider({
    name: boardId, document, token: 'cookie', websocketProvider: socket,
    onStateless({ payload }) {
      const message = protocolModule.parseServerMessage(payload);
      if (message) messages.push(message);
    },
    onAuthenticationFailed() { failure = true; },
  });
  provider.attach();
  const client = {
    document, messages,
    acknowledgement() { return messages.filter(message => message.type === 'persisted').at(-1); },
    saved() {
      const ack = this.acknowledgement();
      return saveModule.matchesPersistedSnapshot(document, ack ? saveModule.decodePersistedSnapshot(ack.snapshot) : null);
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      provider.destroy(); socket.destroy(); document.destroy();
    },
  };
  clients.push(client);
  void socket.connect().catch(() => { failure = true; });
  await waitFor(() => provider.isSynced || failure);
  assert.equal(failure, false, 'Resource WebSocket handshake failed');
  provider.sendStateless('{"type":"persistence-status"}');
  await waitFor(() => client.saved());
  return client;
}

function rectangle(document, id, x) {
  document.getMap('layers').set(id, new Y.Map([
    ['type', 0], ['x', x], ['y', 0], ['width', 100], ['height', 100], ['fill', { r: 1, g: 2, b: 3 }],
  ]));
  document.getArray('layerIds').push([id]);
}

function assertExpected(document) {
  const layers = document.getMap('layers');
  assert.equal(layers.size, expected.size, 'Reloaded layer count differs');
  for (const [id, x] of expected) assert.equal(layers.get(id)?.get('x'), x, 'Acknowledged or pending layer differs');
}

async function stored() {
  const result = await pool.query('SELECT state,revision FROM board_documents WHERE board_id=$1', [boardId]);
  assert.equal(result.rows.length, 1, 'Stored board snapshot is missing');
  return result.rows[0];
}

async function main() {
  await migrationsModule.runMigrations(pool);
  await pool.query('INSERT INTO "user"(id,name,email) VALUES($1,$2,$3)', [ownerId, 'PG resource fixture', ownerId + '@example.test']);
  await pool.query('INSERT INTO boards(id,owner_id,title) VALUES($1,$2,$3)', [boardId, ownerId, 'PG tmpfs failure']);
  server = await startServer();
  const client = await connectClient();
  client.document.transact(() => rectangle(client.document, 'confirmed', 101));
  await waitFor(() => client.saved());
  const baseline = await stored();
  const baselineRevision = Number(baseline.revision);
  assert.equal(client.acknowledgement().revision, baselineRevision);
  emit({ phase: 'baseline', revision: baselineRevision, bytes: baseline.state.length, clientSaved: true });

  await command('edit');
  phase = 'failure';
  client.document.transact(() => {
    for (let index = 0; index < 1_000; index += 1) {
      const id = randomBytes(12).toString('hex');
      const x = randomBytes(4).readUInt32LE() % 1_000_000;
      expected.set(id, x);
      rectangle(client.document, id, x);
    }
  });
  await waitFor(() => client.messages.some(message => message.type === 'persistence-error'));
  await new Promise(resolve => setTimeout(resolve, 500));
  assert.equal(client.saved(), false, 'Unsaved edits are incorrectly marked Saved');
  assert.equal(client.messages.some(message => message.type === 'persisted' && message.revision > baselineRevision), false, 'New persisted ACK was emitted while storage was full');
  const failed = await stored();
  assert.equal(Number(failed.revision), baselineRevision, 'Failed write advanced persisted revision');
  assert.equal(digest(failed.state), digest(baseline.state), 'Failed write changed baseline snapshot');
  emit({ phase: 'failure', noNewAck: true, clientSaved: false, databaseUnchanged: true, pendingLayers: expected.size - 1 });

  await command('recover');
  phase = 'recovered';
  await waitFor(() => client.saved() && client.acknowledgement().revision > baselineRevision, 20_000);
  const recovered = await stored();
  const fromDatabase = new Y.Doc();
  Y.applyUpdate(fromDatabase, recovered.state);
  assertExpected(fromDatabase);
  fromDatabase.destroy();
  emit({ phase: 'recovered', revision: Number(recovered.revision), bytes: recovered.state.length, clientSaved: true, allPreviouslyAckPresent: true, pendingLayersPresent: true });

  phase = 'reloaded';
  client.destroy();
  await server.destroy();
  const beforeReload = await stored();
  assert.equal(digest(beforeReload.state), digest(recovered.state), 'Shutdown changed recovered content');
  assert.ok(Number(beforeReload.revision) >= Number(recovered.revision));
  server = await startServer();
  const reloaded = await connectClient();
  assertExpected(reloaded.document);
  assert.equal(reloaded.acknowledgement().revision, Number(beforeReload.revision));
  emit({ phase: 'reloaded', revision: Number(beforeReload.revision), clientSaved: reloaded.saved(), allPreviouslyAckPresent: true, pendingLayersPresent: true, layers: reloaded.document.getMap('layers').size });
}

try {
  await main();
} catch (error) {
  emit({ phase: 'fixture-error', failedPhase: phase, errorKind: error.name, sqlState: typeof error.code === 'string' && /^[0-9A-Z]{5}$/.test(error.code) ? error.code : undefined });
  process.exitCode = 1;
} finally {
  input.close();
  process.stdin.pause();
  clients.forEach(client => client.destroy());
  if (server) await server.destroy();
  await pool.end();
  clearTimeout(deadline);
}
`;
