import { unlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as Y from 'yjs';

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

function setMarkdown(doc: Y.Doc, value: string): void {
  const text = doc.getText('markdown');
  const current = text.toString();
  if (current.length > 0) text.delete(0, current.length);
  if (value.length > 0) text.insert(0, value);
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function run(): Promise<void> {
  const dbName = `agentdoc-collab-persist-derive-failure-${Date.now()}-${Math.random().toString(36).slice(2)}.db`;
  const dbPath = path.join(os.tmpdir(), dbName);
  const previousDbPath = process.env.DATABASE_PATH;
  const previousDeriveFlag = process.env.COLLAB_FORCE_DERIVE_FRAGMENT_MARKDOWN_FAILURE;
  process.env.DATABASE_PATH = dbPath;

  const db = await import('../../server/db.ts');
  const collab = await import('../../server/collab.ts');

  const slug = `persist-derive-failure-${Math.random().toString(36).slice(2, 10)}`;
  const markdownA = '# Doc\n\nOriginal content.';
  const markdownB = '# Doc\n\nExternal canonical content.\n\nExtra persisted line.';

  try {
    db.createDocument(slug, markdownA, {}, 'derive failure persistence regression');
    await collab.startCollabRuntimeEmbedded(4000);

    const instance = collab.__unsafeGetHocuspocusInstanceForTests() as {
      createDocument?: (
        slug: string,
        request: Record<string, unknown>,
        socketId: string,
        context: Record<string, unknown>,
        hooks: Record<string, unknown>,
      ) => Promise<Y.Doc>;
    };
    assert(instance && typeof instance.createDocument === 'function', 'Expected collab test instance');

    const loadedDoc = await instance.createDocument(
      slug,
      {},
      'persist-derive-failure-socket',
      { isAuthenticated: true, readOnly: false, requiresAuthentication: true },
      {},
    );

    const updated = db.updateDocument(slug, markdownB);
    assert(updated, 'Expected external canonical update to persist');
    const applied = await collab.applyCanonicalDocumentToCollab(slug, {
      markdown: markdownB,
      marks: {},
      source: 'persist-derive-failure-test',
    });
    assert(applied, 'Expected external canonical update to apply to live collab doc');

    const fragmentMarkdownBefore = await collab.getLoadedCollabMarkdownFromFragment(slug);
    assert(
      fragmentMarkdownBefore?.includes('External canonical content.') === true,
      `Expected live fragment markdown to contain external canonical content before forced derive failure. markdown=${String(fragmentMarkdownBefore)}`,
    );

    // Simulate the stale markdown text channel lagging behind a live fragment that is already correct.
    setMarkdown(loadedDoc, markdownA);
    assert(
      loadedDoc.getText('markdown').toString().includes('Original content.'),
      'Expected markdown text channel to be stale before persist',
    );

    process.env.COLLAB_FORCE_DERIVE_FRAGMENT_MARKDOWN_FAILURE = '1';
    collab.__unsafePersistDocFromOnChangeForTests(slug, loadedDoc);
    await sleep(200);

    const row = db.getDocumentBySlug(slug);
    assert(Boolean(row), 'Expected document row after forced derive failure persist');
    assert(
      (row?.markdown ?? '').includes('External canonical content.'),
      `Expected canonical markdown to keep external content when fragment derivation fails. markdown=${(row?.markdown ?? '').slice(0, 160)}`,
    );
    assert(
      !(row?.markdown ?? '').includes('Original content.'),
      `Expected stale markdown text channel not to overwrite canonical markdown. markdown=${(row?.markdown ?? '').slice(0, 160)}`,
    );

    console.log('✓ collab persist skips stale projection writes when fragment derivation fails');
  } finally {
    if (previousDeriveFlag === undefined) {
      delete process.env.COLLAB_FORCE_DERIVE_FRAGMENT_MARKDOWN_FAILURE;
    } else {
      process.env.COLLAB_FORCE_DERIVE_FRAGMENT_MARKDOWN_FAILURE = previousDeriveFlag;
    }
    if (previousDbPath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDbPath;
    }
    await collab.stopCollabRuntime();
    for (const suffix of ['', '-wal', '-shm']) {
      try {
        unlinkSync(`${dbPath}${suffix}`);
      } catch {
        // ignore cleanup errors
      }
    }
  }
}

run().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
