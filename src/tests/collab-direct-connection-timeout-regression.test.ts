import { randomUUID } from 'node:crypto';
import { unlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

async function run(): Promise<void> {
  const dbName = `agentdoc-collab-direct-timeout-${Date.now()}-${randomUUID()}.db`;
  const dbPath = path.join(os.tmpdir(), dbName);
  process.env.DATABASE_PATH = dbPath;
  process.env.COLLAB_DIRECT_CONNECTION_TIMEOUT_MS = '50';

  const db = await import('../../server/db.ts');
  const collab = await import('../../server/collab.ts');

  const slug = `direct-timeout-${Math.random().toString(36).slice(2, 10)}`;

  try {
    db.createDocument(slug, '# Direct timeout\n\nBody.', {}, 'Direct timeout regression');

    await collab.startCollabRuntimeEmbedded(4000);
    const instance = collab.__unsafeGetHocuspocusInstanceForTests() as {
      openDirectConnection?: (documentName: string, context?: unknown) => Promise<unknown>;
    } | null;
    assert(instance && typeof instance.openDirectConnection === 'function', 'Expected hocuspocus test instance');

    const originalOpenDirectConnection = instance.openDirectConnection;
    instance.openDirectConnection = async () => new Promise(() => {});

    const startedAt = Date.now();
    const handle = await collab.loadCanonicalYDoc(slug, { liveRequired: true });
    const elapsedMs = Date.now() - startedAt;

    instance.openDirectConnection = originalOpenDirectConnection;

    assert(handle === null, 'Expected live-required canonical load to return null after direct connection timeout');
    assert(
      elapsedMs < 1000,
      `Expected direct connection timeout to return quickly, took ${elapsedMs}ms`,
    );

    console.log('✓ loadCanonicalYDoc bounds stalled direct live-doc connections');
  } finally {
    delete process.env.COLLAB_DIRECT_CONNECTION_TIMEOUT_MS;
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
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
