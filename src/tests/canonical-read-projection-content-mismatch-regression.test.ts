import { unlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

async function mustJson<T>(res: Response, label: string): Promise<T> {
  const text = await res.text().catch(() => '');
  if (!res.ok) throw new Error(`${label}: HTTP ${res.status}: ${text.slice(0, 500)}`);
  return JSON.parse(text) as T;
}

const CLIENT_HEADERS = {
  'X-Agentdoc-Client-Version': '0.31.2',
  'X-Agentdoc-Client-Build': 'tests',
  'X-Agentdoc-Client-Protocol': '3',
};

async function run(): Promise<void> {
  const dbName = `agentdoc-canonical-read-content-mismatch-${Date.now()}-${Math.random().toString(36).slice(2)}.db`;
  const dbPath = path.join(os.tmpdir(), dbName);

  const prevDatabasePath = process.env.DATABASE_PATH;
  const prevProofEnv = process.env.PROOF_ENV;
  const prevNodeEnv = process.env.NODE_ENV;
  const prevDbEnvInit = process.env.PROOF_DB_ENV_INIT;
  const prevEditV2Enabled = process.env.AGENT_EDIT_V2_ENABLED;

  process.env.DATABASE_PATH = dbPath;
  process.env.PROOF_ENV = 'development';
  process.env.NODE_ENV = 'development';
  process.env.AGENT_EDIT_V2_ENABLED = '1';
  delete process.env.PROOF_DB_ENV_INIT;

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
    const staleMarkdown = '# Projection\n\nstale-body\n';
    const canonicalMarker = 'canonical-row-marker';
    const canonicalMarkdown = `# Projection\n\n${canonicalMarker}\n`;
    const staleMarks = { stale: { kind: 'comment', quote: 'stale-body', text: 'stale', by: 'qa:stale' } };
    const canonicalMarks = { fresh: { kind: 'comment', quote: canonicalMarker, text: 'fresh', by: 'qa:fresh' } };

    const createRes = await fetch(`${httpBase}/api/documents`, {
      method: 'POST',
      headers: {
        ...CLIENT_HEADERS,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        title: 'projection content mismatch',
        markdown: staleMarkdown,
        marks: staleMarks,
      }),
    });
    const created = await mustJson<{ slug: string; ownerSecret: string }>(createRes, 'create');

    const now = new Date().toISOString();
    db.getDb().prepare(`
      UPDATE documents
      SET markdown = ?, marks = ?, revision = 2, y_state_version = 1, updated_at = ?
      WHERE slug = ?
    `).run(canonicalMarkdown, JSON.stringify(canonicalMarks), now, created.slug);

    db.getDb().prepare(`
      UPDATE document_projections
      SET markdown = ?, marks_json = ?, revision = 2, y_state_version = 1, updated_at = ?, health = 'healthy'
      WHERE document_slug = ?
    `).run(staleMarkdown, JSON.stringify(staleMarks), now, created.slug);

    const stateRes = await fetch(`${httpBase}/api/agent/${created.slug}/state`, {
      headers: {
        ...CLIENT_HEADERS,
        'x-share-token': created.ownerSecret,
      },
    });
    const state = await mustJson<{
      success: boolean;
      markdown?: string;
      content?: string;
      marks?: Record<string, { kind?: string }>;
      readSource?: string;
      projectionFresh?: boolean;
      mutationReady?: boolean;
      revision?: number | null;
      _links?: Record<string, unknown>;
    }>(stateRes, 'state');
    const stateMarkdown = typeof state.markdown === 'string' ? state.markdown : (state.content ?? '');
    assert(stateMarkdown.includes(canonicalMarker), 'Expected /state to serve canonical row markdown when projection payload mismatches');
    assert(!stateMarkdown.includes('stale-body'), 'Expected /state to avoid stale projection markdown');
    assert(state.readSource === 'canonical_row', `Expected readSource=canonical_row, got ${String(state.readSource)}`);
    assert(state.projectionFresh === false, 'Expected projectionFresh=false when projection content mismatches canonical');
    assert(state.mutationReady === true, 'Expected mutationReady=true when canonical row is served');
    assert(state.revision === 2, `Expected revision=2, got ${String(state.revision)}`);
    assert(state.marks?.fresh?.kind === 'comment', 'Expected /state to serve canonical row marks');
    assert(Boolean((state._links ?? {}).editV2), 'Expected /state to keep editV2 link when canonical row is mutation-ready');

    const snapshotRes = await fetch(`${httpBase}/api/agent/${created.slug}/snapshot`, {
      headers: {
        ...CLIENT_HEADERS,
        'x-share-token': created.ownerSecret,
      },
    });
    const snapshot = await mustJson<{
      success: boolean;
      blocks?: Array<{ markdown?: string }>;
      readSource?: string;
      projectionFresh?: boolean;
      mutationReady?: boolean;
      revision?: number | null;
      _links?: Record<string, unknown>;
    }>(snapshotRes, 'snapshot');
    const snapshotMarkdown = Array.isArray(snapshot.blocks)
      ? snapshot.blocks.map((block) => String(block.markdown ?? '')).join('\n')
      : '';
    assert(snapshotMarkdown.includes(canonicalMarker), 'Expected /snapshot to serve canonical row markdown when projection payload mismatches');
    assert(snapshot.readSource === 'canonical_row', `Expected snapshot readSource=canonical_row, got ${String(snapshot.readSource)}`);
    assert(snapshot.projectionFresh === false, 'Expected snapshot projectionFresh=false when projection content mismatches canonical');
    assert(snapshot.mutationReady === true, 'Expected snapshot mutationReady=true when canonical row is served');
    assert(snapshot.revision === 2, `Expected snapshot revision=2, got ${String(snapshot.revision)}`);
    assert(Boolean((snapshot._links ?? {}).editV2), 'Expected /snapshot to keep editV2 link when canonical row is mutation-ready');

    console.log('✓ canonical read routes serve the canonical row when a projection row claims freshness but its payload is stale');
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));

    if (prevDatabasePath === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = prevDatabasePath;

    if (prevProofEnv === undefined) delete process.env.PROOF_ENV;
    else process.env.PROOF_ENV = prevProofEnv;

    if (prevNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = prevNodeEnv;

    if (prevDbEnvInit === undefined) delete process.env.PROOF_DB_ENV_INIT;
    else process.env.PROOF_DB_ENV_INIT = prevDbEnvInit;

    if (prevEditV2Enabled === undefined) delete process.env.AGENT_EDIT_V2_ENABLED;
    else process.env.AGENT_EDIT_V2_ENABLED = prevEditV2Enabled;

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
