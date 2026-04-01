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

async function run(): Promise<void> {
  const dbName = `agentdoc-collab-onchange-stale-${Date.now()}-${Math.random().toString(36).slice(2)}.db`;
  const dbPath = path.join(os.tmpdir(), dbName);
  process.env.DATABASE_PATH = dbPath;

  const db = await import('../../server/db.ts');
  const collab = await import('../../server/collab.ts');

  const slug = `onchange-stale-${Math.random().toString(36).slice(2, 10)}`;
  const markdownA = '# Doc\n\nOld content.';
  const markdownB = '# Doc\n\nExternal canonical content.';

  try {
    db.createDocument(slug, markdownA, {}, 'onChange stale overwrite test');

    const ydocA = new Y.Doc();
    setMarkdown(ydocA, markdownA);
    const updateA = Y.encodeStateAsUpdate(ydocA);
    const seqA = db.appendYUpdate(slug, updateA, 'seed');
    db.saveYSnapshot(slug, seqA, updateA);

    // Load metadata baseline as if the doc were actively loaded in collab runtime.
    await collab.startCollabRuntimeEmbedded(4000);
    const instance = collab.__unsafeGetHocuspocusInstanceForTests() as {
      createDocument?: (
        name: string,
        requestParameters: Record<string, string>,
        socketId: string,
        context: { isAuthenticated: boolean; readOnly: boolean; requiresAuthentication: boolean },
        requestHeaders: Record<string, string>,
      ) => Promise<Y.Doc>;
    };
    assert(typeof instance?.createDocument === 'function', 'Expected hocuspocus test instance');
    const loadedDoc = await instance.createDocument!(
      slug,
      {},
      'test-socket-onchange',
      { isAuthenticated: true, readOnly: false, requiresAuthentication: true },
      {},
    );
    assert(
      loadedDoc.getText('markdown').toString().includes('Old content.'),
      'Expected loaded collab doc to start at old content',
    );

    // Simulate external canonical write from another runtime instance.
    const ydocB = new Y.Doc();
    Y.applyUpdate(ydocB, updateA);
    setMarkdown(ydocB, markdownB);
    const deltaB = Y.encodeStateAsUpdate(ydocB, Y.encodeStateVector(ydocA));
    db.appendYUpdate(slug, deltaB, 'external-edit');
    const updated = db.updateDocument(slug, markdownB);
    assert(updated, 'Expected external canonical update to persist');

    // Simulate stale onChange persistence (this previously overwrote markdownB).
    collab.__unsafePersistDocFromOnChangeForTests(slug, loadedDoc);

    const row = db.getDocumentBySlug(slug);
    assert(Boolean(row), 'Expected document row after stale onChange persist');
    assert(
      (row?.markdown ?? '').includes('External canonical content.'),
      `Expected external canonical content to survive stale onChange write. markdown=${(row?.markdown ?? '').slice(0, 160)}`,
    );
    assert(
      !(row?.markdown ?? '').includes('Old content.'),
      `Expected stale in-memory content not to overwrite canonical markdown. markdown=${(row?.markdown ?? '').slice(0, 160)}`,
    );

    console.log('✓ onChange stale persistence does not overwrite newer canonical markdown');
  } finally {
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

