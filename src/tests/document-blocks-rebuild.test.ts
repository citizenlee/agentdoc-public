import { unlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

async function run(): Promise<void> {
  const dbName = `agentdoc-doc-blocks-${Date.now()}-${Math.random().toString(36).slice(2)}.db`;
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

  try {
    const slug = `blocks-${Math.random().toString(36).slice(2, 10)}`;
    const markdownV1 = ['# Title', '', 'First paragraph.', '', 'Second paragraph.'].join('\n');

    const docV1 = db.createDocument(slug, markdownV1, {}, 'Blocks test');
    await db.rebuildDocumentBlocks(docV1, docV1.markdown, docV1.revision);

    const blocksV1 = db.listLiveDocumentBlocks(docV1.doc_id!);
    assert(blocksV1.length === 3, `Expected 3 blocks, got ${blocksV1.length}`);

    const markdownV2 = ['# Title', '', 'Inserted paragraph.', '', 'First paragraph.', '', 'Second paragraph.'].join('\n');
    const updatedV2 = db.updateDocument(slug, markdownV2);
    assert(updatedV2, 'Expected updateDocument to succeed for v2');

    const docV2 = db.getDocumentBySlug(slug)!;
    await db.rebuildDocumentBlocks(docV2, docV2.markdown, docV2.revision);

    const blocksV2 = db.listLiveDocumentBlocks(docV2.doc_id!);
    assert(blocksV2.length === 4, `Expected 4 blocks after insert, got ${blocksV2.length}`);
    assert(blocksV2[0].block_id === blocksV1[0].block_id, 'Expected heading block id to remain stable');
    assert(blocksV2[2].block_id === blocksV1[1].block_id, 'Expected first paragraph block id to remain stable after insert');
    assert(blocksV2[3].block_id === blocksV1[2].block_id, 'Expected second paragraph block id to remain stable after insert');

    const markdownV3 = ['# Title', '', 'First paragraph.'].join('\n');
    const updatedV3 = db.updateDocument(slug, markdownV3);
    assert(updatedV3, 'Expected updateDocument to succeed for v3');

    const docV3 = db.getDocumentBySlug(slug)!;
    await db.rebuildDocumentBlocks(docV3, docV3.markdown, docV3.revision);

    const blocksV3 = db.listLiveDocumentBlocks(docV3.doc_id!);
    assert(blocksV3.length === 2, `Expected 2 blocks after delete, got ${blocksV3.length}`);

    const allBlocks = db.listDocumentBlocks(docV3.doc_id!);
    const retired = allBlocks.filter((block) => block.retired_revision !== null);
    assert(retired.length >= 1, 'Expected at least one retired block');
    const retiredSecond = retired.find((block) => block.block_id === blocksV1[2].block_id);
    assert(
      retiredSecond?.retired_revision === docV3.revision,
      'Expected removed block to be retired at latest revision',
    );

    console.log('✓ document_blocks rebuild preserves stable IDs and retires removed blocks');
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
