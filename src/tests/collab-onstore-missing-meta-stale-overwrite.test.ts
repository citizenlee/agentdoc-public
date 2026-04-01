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
  const dbName = `agentdoc-collab-onstore-missing-meta-${Date.now()}-${Math.random().toString(36).slice(2)}.db`;
  const dbPath = path.join(os.tmpdir(), dbName);
  process.env.DATABASE_PATH = dbPath;

  const db = await import('../../server/db.ts');
  const collab = await import('../../server/collab.ts');

  const slug = `onstore-missing-meta-${Math.random().toString(36).slice(2, 10)}`;
  const markdownA = '# Doc\n\nOld content.';
  const markdownB = '# Doc\n\nExternal canonical content.';

  try {
    db.createDocument(slug, markdownA, {}, 'onStore missing-meta stale overwrite test');

    const ydocA = new Y.Doc();
    setMarkdown(ydocA, markdownA);
    const updateA = Y.encodeStateAsUpdate(ydocA);
    const seqA = db.appendYUpdate(slug, updateA, 'seed');
    db.saveYSnapshot(slug, seqA, updateA);

    // Simulate an external canonical write from another runtime instance.
    const ydocB = new Y.Doc();
    Y.applyUpdate(ydocB, updateA);
    setMarkdown(ydocB, markdownB);
    const deltaB = Y.encodeStateAsUpdate(ydocB, Y.encodeStateVector(ydocA));
    db.appendYUpdate(slug, deltaB, 'external-edit');
    const updated = db.updateDocument(slug, markdownB);
    assert(updated, 'Expected external canonical update to persist');

    // This simulates an onStoreDocument callback from a stale in-memory doc where
    // local metadata was already evicted/missing.
    const staleInMemory = new Y.Doc();
    Y.applyUpdate(staleInMemory, updateA);
    await collab.__unsafePersistOnStoreDocumentForTests(slug, staleInMemory);

    const row = db.getDocumentBySlug(slug);
    assert(Boolean(row), 'Expected document row after stale onStore persist');
    assert(
      (row?.markdown ?? '').includes('External canonical content.'),
      `Expected external canonical content to survive stale onStoreDocument write. markdown=${(row?.markdown ?? '').slice(0, 160)}`,
    );
    assert(
      !(row?.markdown ?? '').includes('Old content.'),
      `Expected stale in-memory content not to overwrite canonical markdown. markdown=${(row?.markdown ?? '').slice(0, 160)}`,
    );

    console.log('✓ missing-meta onStoreDocument does not overwrite newer canonical markdown');
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
