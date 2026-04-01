import { unlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import * as Y from 'yjs';
import { prosemirrorToYXmlFragment } from 'y-prosemirror';
import { getHeadlessMilkdownParser } from '../../server/milkdown-headless.js';

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

async function mustJson<T>(res: Response, label: string): Promise<T> {
  const text = await res.text().catch(() => '');
  if (!res.ok) throw new Error(`${label}: HTTP ${res.status}: ${text.slice(0, 500)}`);
  return JSON.parse(text) as T;
}

type CreateResponse = { slug: string; ownerSecret: string };
type RepairResponse = { success: boolean; slug: string; health: string };
type CloneResponse = { success: boolean; cloneSlug: string; ownerSecret?: string };
type StateResponse = { success: boolean; markdown?: string; content?: string };

async function run(): Promise<void> {
  const dbName = `agentdoc-canonical-repair-${Date.now()}-${Math.random().toString(36).slice(2)}.db`;
  const dbPath = path.join(os.tmpdir(), dbName);
  process.env.DATABASE_PATH = dbPath;

  const [{ apiRoutes }, { agentRoutes }, db] = await Promise.all([
    import('../../server/routes.js'),
    import('../../server/agent-routes.js'),
    import('../../server/db.js'),
  ]);

  const app = express();
  app.use(express.json({ limit: '2mb' }));
  app.use('/api', apiRoutes);
  app.use('/api/agent', agentRoutes);

  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address() as AddressInfo;
  const httpBase = `http://127.0.0.1:${address.port}`;

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
        markdown: '# Canonical repair\n\nOriginal projection.',
        marks: {},
        title: 'Canonical repair',
      }),
    });
    const created = await mustJson<CreateResponse>(createRes, 'create');

    const parser = await getHeadlessMilkdownParser();
    const canonicalMarkdown = '# Canonical repair\n\nRecovered from canonical Yjs.';
    const ydoc = new Y.Doc();
    ydoc.getText('markdown').insert(0, canonicalMarkdown);
    prosemirrorToYXmlFragment(parser.parseMarkdown(canonicalMarkdown) as any, ydoc.getXmlFragment('prosemirror') as any);
    db.saveYSnapshot(created.slug, 1, Y.encodeStateAsUpdate(ydoc));
    db.getDb().prepare(`
      UPDATE documents
      SET y_state_version = 1
      WHERE slug = ?
    `).run(created.slug);

    const corrupted = db.replaceDocumentProjection(created.slug, '# Broken projection\n\nWrong text.', {}, 1);
    assert(corrupted === true, 'Expected corrupted projection write to succeed');
    assert(
      db.getProjectedDocumentBySlug(created.slug)?.markdown.includes('Broken projection') === true,
      'Expected projection row to be corrupted before repair',
    );

    const repairRes = await fetch(`${httpBase}/api/agent/${created.slug}/repair`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Agentdoc-Client-Version': '0.31.2',
        'X-Agentdoc-Client-Build': 'tests',
        'X-Agentdoc-Client-Protocol': '3',
        'x-share-token': created.ownerSecret,
      },
      body: JSON.stringify({ by: 'owner:test' }),
    });
    const repaired = await mustJson<RepairResponse>(repairRes, 'repair');
    assert(repaired.success === true, 'Expected repair success');
    assert(repaired.health === 'healthy', `Expected repaired document health=healthy, got ${repaired.health}`);
    assert(
      db.getProjectedDocumentBySlug(created.slug)?.markdown.includes('Recovered from canonical Yjs.') === true,
      'Expected repair to rebuild projection from canonical Yjs state',
    );

    const cloneRes = await fetch(`${httpBase}/api/agent/${created.slug}/clone-from-canonical`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Agentdoc-Client-Version': '0.31.2',
        'X-Agentdoc-Client-Build': 'tests',
        'X-Agentdoc-Client-Protocol': '3',
        'x-share-token': created.ownerSecret,
      },
      body: JSON.stringify({ by: 'owner:test' }),
    });
    const clone = await mustJson<CloneResponse>(cloneRes, 'clone-from-canonical');
    assert(clone.success === true, 'Expected clone-from-canonical success');
    assert(typeof clone.cloneSlug === 'string' && clone.cloneSlug.length > 0, 'Expected clone slug');
    assert(typeof clone.ownerSecret === 'string' && clone.ownerSecret.length > 0, 'Expected clone owner secret');

    const cloneStateRes = await fetch(`${httpBase}/api/agent/${clone.cloneSlug}/state`, {
      headers: {
        'X-Agentdoc-Client-Version': '0.31.2',
        'X-Agentdoc-Client-Build': 'tests',
        'X-Agentdoc-Client-Protocol': '3',
        'x-share-token': clone.ownerSecret as string,
      },
    });
    const cloneState = await mustJson<StateResponse>(cloneStateRes, 'clone state');
    const cloneMarkdown = typeof cloneState.markdown === 'string' ? cloneState.markdown : (cloneState.content ?? '');
    assert(cloneMarkdown.includes('Recovered from canonical Yjs.'), 'Expected cloned doc to preserve canonical content');

    console.log('✓ canonical repair and clone-from-canonical endpoints rebuild from Yjs state');
  } finally {
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

run().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
