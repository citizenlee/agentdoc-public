import { unlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import express from 'express';
import * as Y from 'yjs';
import type { AddressInfo } from 'node:net';

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

function setMarkdown(doc: Y.Doc, value: string): void {
  const text = doc.getText('markdown');
  const current = text.toString();
  if (current.length > 0) text.delete(0, current.length);
  if (value.length > 0) text.insert(0, value);
}

type CreatedDoc = { slug: string; ownerSecret: string };
type StatePayload = { updatedAt: string };
type ReadDocPayload = { markdown: string };

async function mustJson<T>(res: Response, label: string): Promise<T> {
  const text = await res.text().catch(() => '');
  if (!res.ok) throw new Error(`${label}: HTTP ${res.status}: ${text.slice(0, 400)}`);
  return JSON.parse(text) as T;
}

async function run(): Promise<void> {
  const dbName = `agentdoc-agent-edit-canonical-base-${Date.now()}.db`;
  const dbPath = path.join(os.tmpdir(), dbName);
  process.env.DATABASE_PATH = dbPath;
  process.env.COLLAB_EMBEDDED_WS = '1';

  const [{ apiRoutes }, { agentRoutes }, collab] = await Promise.all([
    import('../../server/routes.js'),
    import('../../server/agent-routes.js'),
    import('../../server/collab.js'),
  ]);

  const app = express();
  app.use(express.json({ limit: '2mb' }));
  app.use('/api', apiRoutes);
  app.use('/api/agent', agentRoutes);

  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address() as AddressInfo;
  const httpBase = `http://127.0.0.1:${address.port}`;

  await collab.startCollabRuntimeEmbedded(address.port);
  try {
    const createRes = await fetch(`${httpBase}/api/documents`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Agentdoc-Client-Version': '0.31.2',
        'X-Agentdoc-Client-Build': 'tests',
        'X-Agentdoc-Client-Protocol': '3',
      },
      body: JSON.stringify({
        title: 'Canonical base regression',
        markdown: '# Title\n\n## Wednesday\n\nOriginal Line\n',
        marks: {},
      }),
    });
    const created = await mustJson<CreatedDoc>(createRes, 'create');

    const stateRes = await fetch(`${httpBase}/api/agent/${created.slug}/state`, {
      headers: { 'x-share-token': created.ownerSecret },
    });
    const state = await mustJson<StatePayload>(stateRes, 'state');

    const instance = collab.__unsafeGetHocuspocusInstanceForTests() as any;
    assert(instance && typeof instance.createDocument === 'function', 'Expected hocuspocus test instance');
    const loadedDoc = await instance.createDocument(
      created.slug,
      {},
      'test-socket',
      { isAuthenticated: true, readOnly: false, requiresAuthentication: true },
      {},
    );

    // Intentionally drift in-memory collab markdown away from canonical DB markdown.
    setMarkdown(loadedDoc, '# Title\n\n## Wednesday\n\nDRIFT ONLY\n');
    assert(
      String(loadedDoc.getText('markdown').toString()).includes('DRIFT ONLY'),
      'Expected in-memory doc drift marker',
    );

    const editRes = await fetch(`${httpBase}/api/agent/${created.slug}/edit`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-share-token': created.ownerSecret,
      },
      body: JSON.stringify({
        by: 'ai:test',
        baseUpdatedAt: state.updatedAt,
        operations: [
          {
            op: 'replace',
            search: 'Original Line',
            content: 'Updated Line',
          },
        ],
      }),
    });
    const editPayload = await mustJson<{ success: boolean }>(editRes, 'edit');
    assert(editPayload.success === true, 'Expected edit success against canonical base');

    const docRes = await fetch(`${httpBase}/api/documents/${created.slug}`, {
      headers: { 'x-share-token': created.ownerSecret },
    });
    const doc = await mustJson<ReadDocPayload>(docRes, 'read');
    assert(doc.markdown.includes('Updated Line'), 'Expected canonical replacement to persist');
    assert(!doc.markdown.includes('DRIFT ONLY'), 'Expected drifted in-memory markdown not to leak into canonical doc');

    console.log('✓ agent /edit uses canonical DB base when collab in-memory markdown drifts');
  } finally {
    await collab.stopCollabRuntime();
    await new Promise<void>((resolve) => server.close(() => resolve()));
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
