import { unlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

async function run(): Promise<void> {
  const dbName = `agentdoc-agent-edit-v2-canonical-base-${Date.now()}-${Math.random().toString(36).slice(2)}.db`;
  const dbPath = path.join(os.tmpdir(), dbName);
  process.env.DATABASE_PATH = dbPath;

  const [{ createDocument, getDocumentBySlug, getDb }, { buildAgentSnapshot }, { applyAgentEditV2 }] = await Promise.all([
    import('../../server/db.js'),
    import('../../server/agent-snapshot.js'),
    import('../../server/agent-edit-v2.js'),
  ]);

  const slug = `projected-base-${Date.now().toString(36)}`;
  const noteBlock = 'Use this section for the soak append loop.';
  const baseMarkdown = [
    '# Long Session',
    '',
    'Part 1',
    '',
    'This is a longer collaborative session fixture with enough room for repeated appends and rewrites.',
    '',
    'Part 2',
    '',
    'The second section gives another landing zone for markers and comments.',
    '',
    'Notes',
    '',
    noteBlock,
  ].join('\n');

  createDocument(slug, baseMarkdown, {}, 'canonical base regression');

  const browserMarker = 'browser-marker-projected';
  const projectedMarkdown = baseMarkdown.replace(noteBlock, `${noteBlock} ${browserMarker}`);
  const now = new Date().toISOString();
  getDb().prepare(`
    UPDATE document_projections
    SET markdown = ?, plain_text = ?, updated_at = ?, health = 'healthy'
    WHERE document_slug = ?
  `).run(projectedMarkdown, projectedMarkdown, now, slug);

  const snapshotResult = await buildAgentSnapshot(slug);
  assert(snapshotResult.status === 200, `Expected snapshot status 200, got ${snapshotResult.status}`);
  const snapshot = snapshotResult.body as {
    revision?: number;
    blocks?: Array<{ ref?: string; markdown?: string }>;
  };
  assert(snapshot.revision === 1, `Expected revision 1, got ${String(snapshot.revision)}`);
  const projectedBlock = snapshot.blocks?.find((block) => block.markdown?.includes(noteBlock));
  assert(projectedBlock?.ref, 'Expected snapshot block ref for projected note block');
  assert(
    projectedBlock.markdown?.includes(browserMarker) !== true,
    'Expected snapshot block markdown to ignore stale projected document state',
  );

  const apiMarker = 'api-marker-projected';
  const result = await applyAgentEditV2(slug, {
    by: 'ai:regression-test',
    baseRevision: snapshot.revision,
    operations: [
      {
        op: 'replace_block',
        ref: projectedBlock.ref,
        block: { markdown: `${projectedBlock.markdown} ${apiMarker}` },
      },
    ],
  });
  assert(result.status === 200, `Expected edit.v2 success, got ${result.status}: ${JSON.stringify(result.body)}`);

  const updated = getDocumentBySlug(slug);
  assert(updated !== undefined, 'Expected updated document');
  assert(updated?.markdown.includes(browserMarker) !== true, 'Expected stale projected browser marker to be ignored');
  assert(updated?.markdown.includes(apiMarker), 'Expected edit.v2 apply to append API marker');

  console.log('✓ agent /edit/v2 uses canonical snapshot state as its mutation base');

  for (const suffix of ['', '-wal', '-shm']) {
    try {
      unlinkSync(`${dbPath}${suffix}`);
    } catch {
      // ignore cleanup errors
    }
  }
}

run()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
