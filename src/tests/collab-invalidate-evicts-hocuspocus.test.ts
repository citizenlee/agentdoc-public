import { unlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as Y from 'yjs';

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

async function sleep(ms: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}

async function waitFor(fn: () => boolean, timeoutMs: number): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (fn()) return;
    await sleep(10);
  }
  throw new Error('Timed out waiting for condition');
}

async function run(): Promise<void> {
  const dbName = `agentdoc-share-collab-invalidate-${Date.now()}-${Math.random().toString(36).slice(2)}.db`;
  const dbPath = path.join(os.tmpdir(), dbName);
  process.env.DATABASE_PATH = dbPath;

  const db = await import('../../server/db.ts');
  const collab = await import('../../server/collab.ts');

  const slug = `collab-evict-${Math.random().toString(36).slice(2, 10)}`;

  await collab.startCollabRuntimeEmbedded(4000);
  try {
    db.createDocument(slug, '# Content A\n\nLong.', {}, 'Evict test');

    // Seed a persisted collab state so hydrateDocFromDb prefers it.
    const ydocA = new Y.Doc();
    ydocA.getText('markdown').insert(0, '# Content A\n\nLong.');
    const updateA = Y.encodeStateAsUpdate(ydocA);
    const seq = db.appendYUpdate(slug, updateA, 'test');
    db.saveYSnapshot(slug, seq, updateA);

    const instance = collab.__unsafeGetHocuspocusInstanceForTests() as any;
    assert(instance && typeof instance.createDocument === 'function', 'Expected collab runtime to expose a hocuspocus instance');

    // Load the doc into Hocuspocus's internal documents map.
    const loaded = await instance.createDocument(
      slug,
      {},
      'test-socket',
      { isAuthenticated: true, readOnly: false, requiresAuthentication: true },
      {},
    );
    assert(typeof loaded?.getText === 'function', 'Expected hocuspocus document to be a Y.Doc');
    assert(String(loaded.getText('markdown').toString()).includes('Content A'), 'Expected hocuspocus document to reflect persisted content A');
    assert(instance.documents?.has?.(slug) === true, 'Expected hocuspocus to retain the document in-memory');

    // Canonical update happens via REST.
    db.updateDocument(slug, '# Content B\n\nShort.');

    // Invalidate should clear persisted state *and* evict the in-memory Hocuspocus document.
    collab.invalidateCollabDocument(slug);
    await waitFor(() => instance.documents?.has?.(slug) === false, 2000);

    const snapshotAfter = db.getLatestYSnapshot(slug);
    const updatesAfter = db.getYUpdatesAfter(slug, 0);
    assert(snapshotAfter === null, 'Expected Yjs snapshot to be cleared on invalidate');
    assert(updatesAfter.length === 0, 'Expected Yjs updates to be cleared on invalidate');

    // Re-load should now seed from canonical markdown, not the stale in-memory/Yjs persistence.
    const reloaded = await instance.createDocument(
      slug,
      {},
      'test-socket-2',
      { isAuthenticated: true, readOnly: false, requiresAuthentication: true },
      {},
    );
    assert(String(reloaded.getText('markdown').toString()).includes('Content B'), 'Expected reloaded hocuspocus document to reflect canonical content B');

    console.log('✓ invalidateCollabDocument evicts hocuspocus documents and clears persisted Yjs state');
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

