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
  const dbName = `agentdoc-collab-contextless-persist-${Date.now()}-${Math.random().toString(36).slice(2)}.db`;
  const dbPath = path.join(os.tmpdir(), dbName);
  const previousDbPath = process.env.DATABASE_PATH;
  process.env.DATABASE_PATH = dbPath;

  const db = await import('../../server/db.ts');
  const collab = await import('../../server/collab.ts');
  const { getHeadlessMilkdownParser } = await import('../../server/milkdown-headless.ts');

  const slug = `contextless-persist-${Math.random().toString(36).slice(2, 10)}`;
  const initialMarkdown = [
    '# Long Session',
    '',
    'This is a longer collaborative session fixture with enough room for repeated appends and rewrites.',
  ].join('\n');
  const browserMarker = `browser-marker-${Math.random().toString(36).slice(2, 8)}`;
  const nextMarkdown = [
    '# Long Session',
    '',
    `This is a longer collaborative session fixture with enough room for repeated appends and rewrites. ${browserMarker}`,
  ].join('\n');

  try {
    db.createDocument(slug, initialMarkdown, {}, 'contextless browser persist regression');

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
      'contextless-browser-persist-socket',
      { isAuthenticated: true, readOnly: false, requiresAuthentication: true },
      {},
    );
    const loadedDoc = collab.__unsafeGetLoadedDocForTests(slug);
    assert(Boolean(loadedDoc), 'Expected live loaded doc after collab load');

    const parser = await getHeadlessMilkdownParser();
    const nextDoc = parser.parseMarkdown(nextMarkdown);
    loadedDoc!.transact(() => {
      const fragment = loadedDoc!.getXmlFragment('prosemirror');
      const length = fragment.length;
      if (length > 0) fragment.delete(0, length);
      prosemirrorToYXmlFragment(nextDoc as any, fragment as any);
    }, 'browser-edit-without-context');

    await sleep(600);

    const row = db.getDocumentBySlug(slug);
    assert(Boolean(row), 'Expected canonical document row after contextless browser edit');
    assert(
      (row?.markdown ?? '').includes(browserMarker),
      `Expected contextless browser-origin fragment edit to persist canonically. markdown=${String(row?.markdown ?? '')}`,
    );

    console.log('✓ contextless browser-origin live edits persist canonically');
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
