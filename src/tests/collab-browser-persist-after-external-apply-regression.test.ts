import { unlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as Y from 'yjs';
import { prosemirrorToYXmlFragment } from 'y-prosemirror';

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function run(): Promise<void> {
  const dbName = `agentdoc-browser-after-external-apply-${Date.now()}-${Math.random().toString(36).slice(2)}.db`;
  const dbPath = path.join(os.tmpdir(), dbName);
  const previousDbPath = process.env.DATABASE_PATH;
  process.env.DATABASE_PATH = dbPath;

  const db = await import('../../server/db.ts');
  const collab = await import('../../server/collab.ts');
  const { getHeadlessMilkdownParser } = await import('../../server/milkdown-headless.ts');

  const slug = `browser-after-external-${Math.random().toString(36).slice(2, 10)}`;
  const initialMarkdown = [
    '# Long Session',
    '',
    'This is a longer collaborative session fixture with enough room for repeated appends and rewrites.',
  ].join('\n');
  const apiMarker = `api-marker-${Math.random().toString(36).slice(2, 8)}`;
  const browserMarker = `browser-marker-${Math.random().toString(36).slice(2, 8)}`;
  const apiMarkdown = [
    '# Long Session',
    '',
    `This is a longer collaborative session fixture with enough room for repeated appends and rewrites. ${apiMarker}`,
  ].join('\n');
  const finalMarkdown = `${apiMarkdown} ${browserMarker}`;

  try {
    db.createDocument(slug, initialMarkdown, {}, 'browser persist after external apply regression');

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

    await instance.createDocument(
      slug,
      {},
      'browser-after-external-socket',
      { isAuthenticated: true, readOnly: false, requiresAuthentication: true },
      {},
    );

    const updated = db.updateDocument(slug, apiMarkdown);
    assert(updated, 'Expected canonical API-style update to persist');
    const applied = await collab.applyCanonicalDocumentToCollab(slug, {
      markdown: apiMarkdown,
      marks: {},
      source: 'external-write-test',
    });
    assert(applied, 'Expected external canonical apply to reach live collab doc');

    const loadedDoc = collab.__unsafeGetLoadedDocForTests(slug);
    assert(Boolean(loadedDoc), 'Expected live loaded doc after external apply');

    const parser = await getHeadlessMilkdownParser();
    const nextDoc = parser.parseMarkdown(finalMarkdown);
    loadedDoc!.transact(() => {
      const fragment = loadedDoc!.getXmlFragment('prosemirror');
      const length = fragment.length;
      if (length > 0) fragment.delete(0, length);
      prosemirrorToYXmlFragment(nextDoc as any, fragment as any);
    }, 'browser-edit-without-context');

    await sleep(600);

    const row = db.getDocumentBySlug(slug);
    assert(Boolean(row), 'Expected canonical document row after browser edit following external apply');
    assert(
      (row?.markdown ?? '').includes(apiMarker),
      `Expected canonical markdown to keep API marker after external apply. markdown=${String(row?.markdown ?? '')}`,
    );
    assert(
      (row?.markdown ?? '').includes(browserMarker),
      `Expected browser-origin edit after external apply to persist canonically. markdown=${String(row?.markdown ?? '')}`,
    );

    console.log('✓ browser-origin live edits persist canonically after external apply');
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

run().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exit(1);
});
