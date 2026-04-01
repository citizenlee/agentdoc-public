import { unlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

async function run(): Promise<void> {
  const dbName = `agentdoc-mutation-dual-write-${Date.now()}-${Math.random().toString(36).slice(2)}.db`;
  const dbPath = path.join(os.tmpdir(), dbName);

  const prevDatabasePath = process.env.DATABASE_PATH;
  const prevProofEnv = process.env.PROOF_ENV;
  const prevNodeEnv = process.env.NODE_ENV;
  const prevDbEnvInit = process.env.PROOF_DB_ENV_INIT;

  process.env.DATABASE_PATH = dbPath;
  process.env.PROOF_ENV = 'development';
  process.env.NODE_ENV = 'development';
  process.env.PROOF_DB_ENV_INIT = 'development';

  const db = await import('../../server/db.ts');

  try {
    const slug = `mutation-dual-${Math.random().toString(36).slice(2, 10)}`;
    db.createDocument(slug, '# Stream 2\n\nDual write test.', {}, 'Mutation dual-write test');

    db.storeIdempotencyResult(
      slug,
      'POST /edit/v2',
      'idempotency-test-1',
      { success: true, revision: 2 },
      'request-hash-1',
    );

    const sqlite = db.getDb();

    const legacyIdempotency = sqlite.prepare(`
      SELECT response_json, request_hash
      FROM idempotency_keys
      WHERE idempotency_key = ? AND document_slug = ? AND route = ?
      LIMIT 1
    `).get('idempotency-test-1', slug, 'POST /edit/v2') as { response_json?: string; request_hash?: string } | undefined;
    assert(Boolean(legacyIdempotency?.response_json), 'Expected legacy idempotency_keys row to be written');
    assert(legacyIdempotency?.request_hash === 'request-hash-1', 'Expected legacy idempotency request_hash to match');

    const coordinatorIdempotency = sqlite.prepare(`
      SELECT response_json, request_hash, status_code, tombstone_revision
      FROM mutation_idempotency
      WHERE idempotency_key = ? AND document_slug = ? AND route = ?
      LIMIT 1
    `).get('idempotency-test-1', slug, 'POST /edit/v2') as {
      response_json?: string;
      request_hash?: string;
      status_code?: number;
      tombstone_revision?: number | null;
    } | undefined;
    assert(Boolean(coordinatorIdempotency?.response_json), 'Expected mutation_idempotency row to be written');
    assert(coordinatorIdempotency?.request_hash === 'request-hash-1', 'Expected coordinator request_hash to match');
    assert(coordinatorIdempotency?.status_code === 200, 'Expected coordinator status_code default to 200');
    assert(coordinatorIdempotency?.tombstone_revision == null, 'Expected coordinator tombstone_revision to be null');

    const readBack = db.getStoredIdempotencyRecord(slug, 'POST /edit/v2', 'idempotency-test-1');
    assert(readBack?.requestHash === 'request-hash-1', 'Expected idempotency read path to preserve request hash');

    const eventId = db.addDocumentEvent(
      slug,
      'comment.added',
      { by: 'agent:test', text: 'dual write event' },
      'agent:test',
      'idempotency-test-2',
    );
    assert(eventId > 0, 'Expected addDocumentEvent to return event id');

    const eventRow = sqlite.prepare(`
      SELECT id, idempotency_key, tombstone_revision
      FROM document_events
      WHERE id = ?
      LIMIT 1
    `).get(eventId) as { id?: number; idempotency_key?: string | null; tombstone_revision?: number | null } | undefined;
    assert(eventRow?.id === eventId, 'Expected document_events row to exist');
    assert(eventRow?.idempotency_key === 'idempotency-test-2', 'Expected document_events idempotency key');
    assert(eventRow?.tombstone_revision == null, 'Expected document_events tombstone_revision to default null');

    const outboxRow = sqlite.prepare(`
      SELECT event_id, event_type, idempotency_key, tombstone_revision, delivered_at
      FROM mutation_outbox
      WHERE event_id = ?
      LIMIT 1
    `).get(eventId) as {
      event_id?: number | null;
      event_type?: string;
      idempotency_key?: string | null;
      tombstone_revision?: number | null;
      delivered_at?: string | null;
    } | undefined;
    assert(outboxRow?.event_id === eventId, 'Expected mutation_outbox row keyed to event_id');
    assert(outboxRow?.event_type === 'comment.added', 'Expected mutation_outbox event_type');
    assert(outboxRow?.idempotency_key === 'idempotency-test-2', 'Expected mutation_outbox idempotency key');
    assert(outboxRow?.tombstone_revision == null, 'Expected mutation_outbox tombstone_revision to default null');
    assert(outboxRow?.delivered_at == null, 'Expected mutation_outbox delivered_at to default null');

    const documentEventColumns = sqlite.prepare('PRAGMA table_info(document_events)').all() as Array<{ name: string }>;
    assert(documentEventColumns.some((column) => column.name === 'tombstone_revision'), 'Expected document_events tombstone_revision column');

    const mutationIdempotencyColumns = sqlite.prepare('PRAGMA table_info(mutation_idempotency)').all() as Array<{ name: string }>;
    assert(mutationIdempotencyColumns.some((column) => column.name === 'status_code'), 'Expected mutation_idempotency status_code column');
    assert(mutationIdempotencyColumns.some((column) => column.name === 'tombstone_revision'), 'Expected mutation_idempotency tombstone_revision column');

    const mutationOutboxColumns = sqlite.prepare('PRAGMA table_info(mutation_outbox)').all() as Array<{ name: string }>;
    assert(mutationOutboxColumns.some((column) => column.name === 'event_id'), 'Expected mutation_outbox event_id column');
    assert(mutationOutboxColumns.some((column) => column.name === 'tombstone_revision'), 'Expected mutation_outbox tombstone_revision column');

    console.log('✓ mutation dual-write writes legacy + coordinator tables with tombstone-ready schema');
  } finally {
    if (prevDatabasePath === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = prevDatabasePath;

    if (prevProofEnv === undefined) delete process.env.PROOF_ENV;
    else process.env.PROOF_ENV = prevProofEnv;

    if (prevNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = prevNodeEnv;

    if (prevDbEnvInit === undefined) delete process.env.PROOF_DB_ENV_INIT;
    else process.env.PROOF_DB_ENV_INIT = prevDbEnvInit;

    for (const suffix of ['', '-wal', '-shm']) {
      try {
        unlinkSync(`${dbPath}${suffix}`);
      } catch {
        // ignore cleanup errors
      }
    }
  }
}

run().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
