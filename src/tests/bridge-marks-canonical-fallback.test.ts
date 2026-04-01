import { unlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as Y from 'yjs';

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

async function run(): Promise<void> {
  const dbName = `agentdoc-bridge-marks-fallback-${Date.now()}-${Math.random().toString(36).slice(2)}.db`;
  const dbPath = path.join(os.tmpdir(), dbName);

  const prevDatabasePath = process.env.DATABASE_PATH;
  const prevProofEnv = process.env.PROOF_ENV;
  const prevNodeEnv = process.env.NODE_ENV;
  const prevDbEnvInit = process.env.PROOF_DB_ENV_INIT;

  process.env.DATABASE_PATH = dbPath;
  process.env.PROOF_ENV = 'development';
  process.env.NODE_ENV = 'development';
  delete process.env.PROOF_DB_ENV_INIT;

  const [{ executeDocumentOperation }, db] = await Promise.all([
    import('../../server/document-engine.js'),
    import('../../server/db.js'),
  ]);

  try {
    const slug = `bridge-marks-${Math.random().toString(36).slice(2, 10)}`;
    const baseMarkdown = '# Bridge marks\n\nBase paragraph.\n';
    db.createDocument(slug, baseMarkdown, {}, 'Bridge marks fallback');

    const markerId = 'mark-fallback-1';
    const ydoc = new Y.Doc();
    ydoc.getText('markdown').insert(0, `${baseMarkdown}\nCanonical marker.\n`);
    ydoc.getMap('marks').set(markerId, {
      kind: 'comment',
      by: 'tester',
      text: 'canonical mark',
      createdAt: new Date().toISOString(),
    });
    const snapshot = Y.encodeStateAsUpdate(ydoc);
    db.saveYSnapshot(slug, 1, snapshot);
    db.getDb().prepare('UPDATE documents SET y_state_version = 1 WHERE slug = ?').run(slug);

    const result = executeDocumentOperation(slug, 'GET', '/marks');
    assert(result.status === 200, `Expected 200 from /marks, got ${result.status}`);
    const marks = (result.body as { marks?: Record<string, unknown> }).marks ?? {};
    assert(
      typeof marks === 'object' && marks !== null && Object.prototype.hasOwnProperty.call(marks, markerId),
      'Expected /marks to serve canonical marks from Yjs fallback when projection is stale',
    );

    console.log('✓ /marks serves canonical fallback marks');
  } finally {
    if (prevDatabasePath === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = prevDatabasePath;
    if (prevProofEnv === undefined) delete process.env.PROOF_ENV;
    else process.env.PROOF_ENV = prevProofEnv;
    if (prevNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = prevNodeEnv;
    if (prevDbEnvInit === undefined) delete process.env.PROOF_DB_ENV_INIT;
    else process.env.PROOF_DB_ENV_INIT = prevDbEnvInit;
    try {
      unlinkSync(dbPath);
    } catch {
      // ignore
    }
  }
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
