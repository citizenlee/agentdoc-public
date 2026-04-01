import { randomUUID } from 'node:crypto';
import { unlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as Y from 'yjs';

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

async function run(): Promise<void> {
  const dbName = `agentdoc-agent-edit-v2-detached-live-doc-${Date.now()}-${randomUUID()}.db`;
  const dbPath = path.join(os.tmpdir(), dbName);
  process.env.DATABASE_PATH = dbPath;

  const db = await import('../../server/db.ts');
  const collab = await import('../../server/collab.ts');
  const canonical = await import('../../server/canonical-document.ts');

  const slug = `detached-live-doc-${Math.random().toString(36).slice(2, 10)}`;

  try {
    const created = db.createDocument(
      slug,
      '# Detached live doc\n\nBase paragraph.',
      {},
      'detached live doc regression',
    );
    assert(typeof created.access_epoch === 'number', 'Expected test document to have access_epoch');

    await collab.startCollabRuntimeEmbedded(4000);

    const instance = collab.__unsafeGetHocuspocusInstanceForTests() as {
      openDirectConnection?: (documentName: string, context?: unknown) => Promise<unknown>;
      documents?: Map<string, unknown>;
    } | null;
    assert(instance && typeof instance.openDirectConnection === 'function', 'Expected hocuspocus test instance');

    db.noteDocumentLiveCollabLease(slug, created.access_epoch);

    const originalOpenDirectConnection = instance.openDirectConnection;
    instance.openDirectConnection = async () => ({
      document: new Y.Doc(),
      disconnect: () => undefined,
    });

    const result = await canonical.mutateCanonicalDocument({
      slug,
      nextMarkdown: '# Detached live doc\n\nBase paragraph.\n\nAPI append.',
      nextMarks: {},
      source: 'ai:detached-live-doc-regression',
      baseRevision: created.revision,
      strictLiveDoc: true,
    });

    instance.openDirectConnection = originalOpenDirectConnection;

    assert(!result.ok, `Expected strict live-doc mutation to fail when only a detached direct doc is available: ${JSON.stringify(result)}`);
    assert(result.code === 'LIVE_DOC_UNAVAILABLE', `Expected LIVE_DOC_UNAVAILABLE, got ${String(result.code)}`);

    const row = db.getDocumentBySlug(slug);
    assert(Boolean(row), 'Expected document row after failed mutation');
    assert(
      row?.markdown === created.markdown,
      `Expected canonical markdown to remain unchanged after detached live-doc failure. markdown=${String(row?.markdown)}`,
    );

    console.log('✓ strict live-doc mutations reject detached direct-connection docs');
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

run().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exit(1);
});
