import { mkdtempSync, rmSync, unlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as Y from 'yjs';

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

async function run(): Promise<void> {
  const dbName = `agentdoc-snapshot-html-fallback-${Date.now()}-${Math.random().toString(36).slice(2)}.db`;
  const dbPath = path.join(os.tmpdir(), dbName);
  const snapshotDir = mkdtempSync(path.join(os.tmpdir(), 'agentdoc-snapshot-html-'));

  const prevDatabasePath = process.env.DATABASE_PATH;
  const prevProofEnv = process.env.PROOF_ENV;
  const prevNodeEnv = process.env.NODE_ENV;
  const prevDbEnvInit = process.env.PROOF_DB_ENV_INIT;
  const prevSnapshotDir = process.env.SNAPSHOT_DIR;

  process.env.DATABASE_PATH = dbPath;
  process.env.PROOF_ENV = 'development';
  process.env.NODE_ENV = 'development';
  process.env.SNAPSHOT_DIR = snapshotDir;
  delete process.env.PROOF_DB_ENV_INIT;

  const [{ refreshSnapshotForSlug, getSnapshotHtml }, db] = await Promise.all([
    import('../../server/snapshot.js'),
    import('../../server/db.js'),
  ]);

  try {
    const slug = `snapshot-html-${Math.random().toString(36).slice(2, 10)}`;
    const baseMarkdown = '# Snapshot HTML\n\nBase paragraph.\n';
    const marker = 'snapshot-fallback-marker';
    db.createDocument(slug, baseMarkdown, {}, 'Snapshot fallback');

    const ydoc = new Y.Doc();
    ydoc.getText('markdown').insert(0, `${baseMarkdown}\n${marker}\n`);
    const snapshot = Y.encodeStateAsUpdate(ydoc);
    db.saveYSnapshot(slug, 1, snapshot);
    db.getDb().prepare('UPDATE documents SET y_state_version = 1 WHERE slug = ?').run(slug);

    const ok = refreshSnapshotForSlug(slug);
    assert(ok, 'Expected refreshSnapshotForSlug to succeed');
    const html = getSnapshotHtml(slug);
    assert(typeof html === 'string' && html.includes(marker), 'Expected snapshot HTML to include canonical fallback markdown');

    console.log('✓ snapshot HTML uses canonical fallback markdown');
  } finally {
    if (prevDatabasePath === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = prevDatabasePath;
    if (prevProofEnv === undefined) delete process.env.PROOF_ENV;
    else process.env.PROOF_ENV = prevProofEnv;
    if (prevNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = prevNodeEnv;
    if (prevDbEnvInit === undefined) delete process.env.PROOF_DB_ENV_INIT;
    else process.env.PROOF_DB_ENV_INIT = prevDbEnvInit;
    if (prevSnapshotDir === undefined) delete process.env.SNAPSHOT_DIR;
    else process.env.SNAPSHOT_DIR = prevSnapshotDir;
    try {
      unlinkSync(dbPath);
    } catch {
      // ignore
    }
    try {
      rmSync(snapshotDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
