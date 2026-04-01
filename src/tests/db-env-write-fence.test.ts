import { unlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

function expectThrows(fn: () => unknown, pattern: RegExp, label: string): void {
  let threw = false;
  try {
    fn();
  } catch (error) {
    threw = true;
    const message = error instanceof Error ? error.message : String(error);
    if (!pattern.test(message)) {
      throw new Error(`${label}: expected error matching ${pattern}, got: ${message}`);
    }
  }
  if (!threw) {
    throw new Error(`${label}: expected function to throw`);
  }
}

async function run(): Promise<void> {
  const dbName = `agentdoc-db-env-fence-${Date.now()}-${Math.random().toString(36).slice(2)}.db`;
  const dbPath = path.join(os.tmpdir(), dbName);

  const prevDatabasePath = process.env.DATABASE_PATH;
  const prevProofEnv = process.env.PROOF_ENV;
  const prevNodeEnv = process.env.NODE_ENV;
  const prevDbEnvInit = process.env.PROOF_DB_ENV_INIT;
  const prevOverride = process.env.ALLOW_CROSS_ENV_WRITES;

  process.env.DATABASE_PATH = dbPath;
  process.env.PROOF_ENV = 'development';
  process.env.NODE_ENV = 'development';
  delete process.env.PROOF_DB_ENV_INIT;
  delete process.env.ALLOW_CROSS_ENV_WRITES;

  const db = await import('../../server/db.ts');

  try {
    const slug = `db-fence-${Math.random().toString(36).slice(2, 10)}`;
    db.createDocument(slug, '# Hello\n\nDev copy', {}, 'DB env fence test');

    const dbEnv = db.getDatabaseEnvironment();
    assert(dbEnv === 'development', `Expected initialized DB environment to be development, got ${dbEnv}`);

    const sqlite = db.getDb();
    sqlite.prepare(`
      INSERT OR REPLACE INTO system_metadata (key, value, updated_at)
      VALUES ('db_environment', 'production', ?)
    `).run(new Date().toISOString());

    expectThrows(
      () => db.assertDatabaseEnvironmentSafeForRuntime(),
      /startup blocked due to environment mismatch/i,
      'startup environment check',
    );

    expectThrows(
      () => db.updateDocument(slug, '# Should fail'),
      /environment mismatch/i,
      'updateDocument write fence',
    );

    expectThrows(
      () => db.appendYUpdate(slug, new Uint8Array([1, 2, 3]), 'test'),
      /environment mismatch/i,
      'appendYUpdate write fence',
    );

    process.env.ALLOW_CROSS_ENV_WRITES = '1';
    const updated = db.updateDocument(slug, '# Allowed with override');
    assert(updated, 'Expected updateDocument to succeed with ALLOW_CROSS_ENV_WRITES override');

    const after = db.getDocumentBySlug(slug);
    assert((after?.markdown ?? '').includes('Allowed with override'), 'Expected markdown to update under override');

    console.log('✓ DB environment write fence blocks mismatched writes unless explicit override is set');
  } finally {
    if (prevDatabasePath === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = prevDatabasePath;

    if (prevProofEnv === undefined) delete process.env.PROOF_ENV;
    else process.env.PROOF_ENV = prevProofEnv;

    if (prevNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = prevNodeEnv;

    if (prevDbEnvInit === undefined) delete process.env.PROOF_DB_ENV_INIT;
    else process.env.PROOF_DB_ENV_INIT = prevDbEnvInit;

    if (prevOverride === undefined) delete process.env.ALLOW_CROSS_ENV_WRITES;
    else process.env.ALLOW_CROSS_ENV_WRITES = prevOverride;

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
