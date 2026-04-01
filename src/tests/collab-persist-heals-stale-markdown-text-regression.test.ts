import { unlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as Y from 'yjs';

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let offset = 0;
  while (true) {
    const index = haystack.indexOf(needle, offset);
    if (index < 0) return count;
    count += 1;
    offset = index + needle.length;
  }
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
  const dbName = `agentdoc-collab-heal-stale-markdown-${Date.now()}-${Math.random().toString(36).slice(2)}.db`;
  const dbPath = path.join(os.tmpdir(), dbName);
  const previousDbPath = process.env.DATABASE_PATH;
  process.env.DATABASE_PATH = dbPath;

  const db = await import('../../server/db.ts');
  const collab = await import('../../server/collab.ts');

  const slug = `heal-stale-markdown-${Math.random().toString(36).slice(2, 10)}`;
  const markdown = [
    '# Long Session',
    '',
    '## Part 1',
    '',
    'This is a longer collaborative session fixture with enough room for repeated appends and rewrites.',
    '',
    '## Part 2',
    '',
    'The second section gives another landing zone for markers and comments.',
    '',
    '## Notes',
    '',
    'Use this section for the soak append loop.',
    'soak-api-1',
    'soak-api-2',
  ].join('\n');

  try {
    db.createDocument(slug, markdown, {}, 'heal stale markdown text regression');
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
      'heal-stale-markdown-socket',
      { isAuthenticated: true, readOnly: false, requiresAuthentication: true },
      {},
    );

    const fragmentMarkdownBefore = await collab.getLoadedCollabMarkdownFromFragment(slug);
    assert(
      (fragmentMarkdownBefore ?? '').trim() === markdown.trim(),
      `Expected live fragment markdown to start canonical. markdown=${String(fragmentMarkdownBefore)}`,
    );

    setMarkdown(loadedDoc, `${markdown}\n${markdown}`);
    assert(
      countOccurrences(loadedDoc.getText('markdown').toString(), '# Long Session') === 2,
      'Expected markdown text channel to be duplicated before persist',
    );

    collab.__unsafePersistDocForTests(slug, loadedDoc, 'external-write-test');
    await sleep(250);

    const healedMarkdownText = loadedDoc.getText('markdown').toString();
    assert(
      countOccurrences(healedMarkdownText, '# Long Session') === 1,
      `Expected persist to heal live markdown text channel from fragment. markdown=${healedMarkdownText.slice(0, 240)}`,
    );

    const row = db.getDocumentBySlug(slug);
    assert(Boolean(row), 'Expected document row after persist');
    assert(
      countOccurrences(row?.markdown ?? '', '# Long Session') === 1,
      `Expected canonical markdown to stay single after persist. markdown=${(row?.markdown ?? '').slice(0, 240)}`,
    );

    console.log('✓ collab persist heals stale markdown text from the live fragment before projection writes');
  } finally {
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
