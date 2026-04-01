/**
 * Migration regression test for legacy share rows created before share_state/doc_id columns.
 *
 * Validates that upgrading the server preserves slug identity and maps `active` -> `share_state`
 * correctly, including inactive rows that would otherwise inherit ACTIVE defaults.
 */

import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { unlinkSync } from 'node:fs';
import express from 'express';
import Database from 'better-sqlite3';

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

function cleanupDbArtifacts(dbPath: string): void {
  for (const suffix of ['', '-wal', '-shm']) {
    try {
      unlinkSync(`${dbPath}${suffix}`);
    } catch {
      // ignore cleanup errors
    }
  }
}

function seedLegacyDatabase(dbPath: string): void {
  const legacyDb = new Database(dbPath);
  const now = new Date().toISOString();
  legacyDb.exec(`
    CREATE TABLE documents (
      slug TEXT PRIMARY KEY,
      title TEXT,
      markdown TEXT NOT NULL,
      marks TEXT NOT NULL DEFAULT '{}',
      active INTEGER NOT NULL DEFAULT 1,
      owner_id TEXT,
      owner_secret TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);

  const insert = legacyDb.prepare(`
    INSERT INTO documents (slug, title, markdown, marks, active, owner_id, owner_secret, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  insert.run(
    'legacy-active',
    'Legacy Active',
    '# Active legacy doc\n',
    '{}',
    1,
    'owner-a',
    'legacy-owner-secret-a',
    now,
    now,
  );
  insert.run(
    'legacy-paused',
    'Legacy Paused',
    '# Paused legacy doc\n',
    '{}',
    0,
    'owner-b',
    'legacy-owner-secret-b',
    now,
    now,
  );

  legacyDb.close();
}

async function run(): Promise<void> {
  const dbName = `agentdoc-legacy-migration-${Date.now()}-${Math.random().toString(36).slice(2)}.db`;
  const dbPath = path.join(os.tmpdir(), dbName);
  seedLegacyDatabase(dbPath);
  const prevDatabasePath = process.env.DATABASE_PATH;
  const prevProofDbEnvInit = process.env.PROOF_DB_ENV_INIT;
  process.env.DATABASE_PATH = dbPath;
  process.env.PROOF_DB_ENV_INIT = 'development';

  const { apiRoutes } = await import('../../server/routes.ts');
  const app = express();
  app.use(express.json({ limit: '10mb' }));
  app.use('/api', apiRoutes);

  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));

  try {
    const address = server.address();
    assert(address !== null && typeof address !== 'string', 'Expected server to bind to TCP');
    const base = `http://127.0.0.1:${address.port}`;

    const activeResponse = await fetch(`${base}/api/documents/legacy-active`);
    assert(activeResponse.status === 200, `legacy-active should be readable, got ${activeResponse.status}`);
    const activeJson = await activeResponse.json() as Record<string, unknown>;
    assert(activeJson.slug === 'legacy-active', 'legacy-active slug should be stable');
    assert(activeJson.shareState === 'ACTIVE', 'legacy-active shareState should be ACTIVE');
    assert(activeJson.active === true, 'legacy-active active compatibility field should be true');

    const pausedResponse = await fetch(`${base}/api/documents/legacy-paused`);
    assert(pausedResponse.status === 403, `legacy-paused should be inaccessible without owner secret, got ${pausedResponse.status}`);

    const pausedOwnerResponse = await fetch(`${base}/api/documents/legacy-paused?token=legacy-owner-secret-b`);
    assert(pausedOwnerResponse.status === 200, `legacy-paused should be readable by owner, got ${pausedOwnerResponse.status}`);
    const pausedJson = await pausedOwnerResponse.json() as Record<string, unknown>;
    assert(pausedJson.slug === 'legacy-paused', 'legacy-paused slug should be stable');
    assert(pausedJson.shareState === 'PAUSED', 'legacy-paused shareState should map from active=0');
    assert(pausedJson.active === false, 'legacy-paused active compatibility field should be false');

    const migratedDb = new Database(dbPath, { readonly: true });
    const migratedRows = migratedDb.prepare(`
      SELECT slug, doc_id, share_state, active, owner_secret_hash
      FROM documents
      ORDER BY slug
    `).all() as Array<{
      slug: string;
      doc_id: string | null;
      share_state: string | null;
      active: number;
      owner_secret_hash: string | null;
    }>;
    migratedDb.close();

    assert(migratedRows.length === 2, `Expected 2 migrated rows, got ${migratedRows.length}`);
    const activeRow = migratedRows.find((row) => row.slug === 'legacy-active');
    const pausedRow = migratedRows.find((row) => row.slug === 'legacy-paused');
    assert(Boolean(activeRow?.doc_id), 'legacy-active should receive doc_id during migration');
    assert(Boolean(pausedRow?.doc_id), 'legacy-paused should receive doc_id during migration');
    assert(Boolean(activeRow?.owner_secret_hash), 'legacy-active owner_secret_hash should be backfilled');
    assert(Boolean(pausedRow?.owner_secret_hash), 'legacy-paused owner_secret_hash should be backfilled');
    assert(activeRow?.share_state === 'ACTIVE', 'legacy-active share_state mismatch');
    assert(pausedRow?.share_state === 'PAUSED', 'legacy-paused share_state mismatch');
    assert(activeRow?.active === 1, 'legacy-active active flag should remain 1');
    assert(pausedRow?.active === 0, 'legacy-paused active flag should remain 0');

    console.log('✓ legacy migration preserves slugs and maps active -> share_state correctly');
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (prevDatabasePath === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = prevDatabasePath;
    if (prevProofDbEnvInit === undefined) delete process.env.PROOF_DB_ENV_INIT;
    else process.env.PROOF_DB_ENV_INIT = prevProofDbEnvInit;
    cleanupDbArtifacts(dbPath);
  }
}

run().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
