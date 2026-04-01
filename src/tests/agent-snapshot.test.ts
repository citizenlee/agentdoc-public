import { unlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

async function run(): Promise<void> {
  const dbName = `agentdoc-agent-snapshot-${Date.now()}-${Math.random().toString(36).slice(2)}.db`;
  const dbPath = path.join(os.tmpdir(), dbName);

  const prevDatabasePath = process.env.DATABASE_PATH;
  const prevProofEnv = process.env.PROOF_ENV;
  const prevNodeEnv = process.env.NODE_ENV;
  const prevDbEnvInit = process.env.PROOF_DB_ENV_INIT;

  process.env.DATABASE_PATH = dbPath;
  process.env.PROOF_ENV = 'development';
  process.env.NODE_ENV = 'development';
  delete process.env.PROOF_DB_ENV_INIT;

  const db = await import('../../server/db.ts');
  const { buildAgentSnapshot } = await import('../../server/agent-snapshot.ts');

  try {
    const slug = `snapshot-${Math.random().toString(36).slice(2, 10)}`;
    const markdown = ['# Snapshot', '', 'Hello world.'].join('\n');

    const doc = db.createDocument(slug, markdown, {}, 'Snapshot test');

    const result = await buildAgentSnapshot(slug, {});
    assert(result.status === 200, `Expected 200 snapshot, got ${result.status}`);

    const body = result.body as any;
    assert(Array.isArray(body.blocks), 'Expected snapshot blocks array');
    assert(body.blocks.length === 2, `Expected 2 blocks, got ${body.blocks.length}`);
    assert(body.blocks[0].ref === 'b1', 'Expected first block ref to be b1');

    const storedBlocks = db.listLiveDocumentBlocks(doc.doc_id!);
    assert(storedBlocks.length === 0, 'Expected snapshot GET to avoid rebuilding document_blocks');
    assert(
      body.blocks[0].id === `snapshot:${doc.doc_id}:${doc.revision}:b1`,
      'Expected snapshot block id to fall back to deterministic synthetic ids when no block index exists',
    );

    await db.rebuildDocumentBlocks(doc, markdown, doc.revision);
    const withStoredBlocks = await buildAgentSnapshot(slug, {});
    const withStoredBody = withStoredBlocks.body as any;
    const rebuiltBlocks = db.listLiveDocumentBlocks(doc.doc_id!);
    assert(rebuiltBlocks.length === 2, 'Expected explicit rebuild to populate document_blocks');
    assert(
      withStoredBody.blocks[0].id === rebuiltBlocks[0].block_id,
      'Expected snapshot block id to match stored block id when the block index is current',
    );

    const noPreview = await buildAgentSnapshot(slug, { includeTextPreview: false });
    const noPreviewBody = noPreview.body as any;
    assert(!('textPreview' in noPreviewBody.blocks[0]), 'Expected textPreview to be omitted when includeTextPreview=false');

    const stale = await buildAgentSnapshot(slug, { revision: doc.revision + 5 });
    assert(stale.status === 409, `Expected 409 for unknown revision, got ${stale.status}`);
    const staleBody = stale.body as any;
    assert(staleBody.snapshot && staleBody.snapshot.blocks, 'Expected snapshot payload in revision error response');

    console.log('✓ agent snapshot stays read-only and respects includeTextPreview');
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
