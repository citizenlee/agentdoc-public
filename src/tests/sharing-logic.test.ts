/**
 * Sharing logic checker.
 *
 * Validates the sharing/visibility model for all documents:
 * - Visibility states are valid (private, selective, shared, public)
 * - Selective docs have at least one share entry
 * - Share entries have valid roles
 * - External users (non-domain) have magic tokens
 * - Magic tokens are unique per share
 * - No orphaned shares (shares for deleted documents)
 *
 * Also tests the visibility auto-promotion logic via the API.
 *
 * Usage:
 *   npx tsx src/tests/sharing-logic.test.ts           # audit mode (read-only)
 *   PORT=4000 npx tsx src/tests/sharing-logic.test.ts  # + API tests against running server
 */

import path from 'path';
import { fileURLToPath } from 'url';
import os from 'os';
import { randomUUID } from 'crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// --- Assertion helpers ---

let passed = 0;
let failed = 0;
let warnings = 0;

function test(name: string, fn: () => void) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failed++;
    console.error(`  ✗ ${name}`);
    console.error(`    ${(error as Error).message}`);
  }
}

function assert(condition: boolean, message: string) {
  if (!condition) throw new Error(message);
}

function assertEqual<T>(actual: T, expected: T, message?: string) {
  if (actual !== expected) {
    throw new Error(message ?? `Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function warn(message: string) {
  warnings++;
  console.log(`  ⚠ ${message}`);
}

// --- Database audit ---

async function auditDatabase() {
  console.log('\n── Database Audit ──\n');

  // Set up isolated DB path or use existing
  const dbPath = process.env.DATABASE_PATH || path.join(__dirname, '..', '..', 'agentdoc.db');
  process.env.DATABASE_PATH = dbPath;

  const { getDocumentBySlug, getDocumentVisibility, getDocumentOwnerEmail } = await import('../../server/db.ts');
  const { getDocumentShares } = await import('../../server/mcp/sharing.ts');

  const Database = (await import('better-sqlite3')).default;
  let db: InstanceType<typeof Database>;
  try {
    db = new Database(dbPath, { readonly: true });
    db.prepare('SELECT 1 FROM documents LIMIT 1').get();
  } catch {
    console.log('  No local database found. Skipping audit.\n  (Run against production by copying the DB or use PORT= for API tests)\n');
    return;
  }

  const allDocs = db.prepare('SELECT slug, visibility, owner_email, active FROM documents').all() as Array<{
    slug: string; visibility: string; owner_email: string | null; active: number;
  }>;

  let allShares: Array<{
    id: number; document_slug: string; email: string; role: string;
    granted_by: string | null; magic_token: string | null; created_at: string;
  }> = [];
  try {
    allShares = db.prepare('SELECT * FROM document_shares').all() as typeof allShares;
  } catch {
    console.log('  document_shares table not found. No shares to audit.\n');
  }

  const allowedDomain = process.env.GOOGLE_ALLOWED_DOMAIN || 'cultivarium.org';
  const validVisibilities = new Set(['private', 'selective', 'shared', 'public']);
  const validRoles = new Set(['viewer', 'commenter', 'editor']);
  const seenTokens = new Map<string, string>(); // token → slug:email

  console.log(`  Documents: ${allDocs.length}, Shares: ${allShares.length}\n`);

  // Index shares by slug
  const sharesBySlug = new Map<string, typeof allShares>();
  for (const s of allShares) {
    const arr = sharesBySlug.get(s.document_slug) || [];
    arr.push(s);
    sharesBySlug.set(s.document_slug, arr);
  }

  // Check each document
  for (const doc of allDocs) {
    if (!doc.active) continue; // skip deleted docs

    const shares = sharesBySlug.get(doc.slug) || [];

    test(`[${doc.slug}] visibility "${doc.visibility}" is valid`, () => {
      assert(validVisibilities.has(doc.visibility), `Invalid visibility: "${doc.visibility}"`);
    });

    if (doc.visibility === 'selective') {
      test(`[${doc.slug}] selective doc has at least one share`, () => {
        assert(shares.length > 0, 'Selective visibility but no shares — should be private instead');
      });
    }

    for (const share of shares) {
      test(`[${doc.slug}] share ${share.email} has valid role`, () => {
        assert(validRoles.has(share.role), `Invalid role: "${share.role}"`);
      });

      const isExternal = !share.email.endsWith('@' + allowedDomain);

      if (isExternal) {
        test(`[${doc.slug}] external user ${share.email} has magic token`, () => {
          assert(!!share.magic_token, 'External user missing magic_token — they cannot access without it');
        });
      }

      if (share.magic_token) {
        test(`[${doc.slug}] magic token for ${share.email} is unique`, () => {
          const key = `${share.document_slug}:${share.email}`;
          const existing = seenTokens.get(share.magic_token!);
          assert(!existing || existing === key, `Duplicate token! Also used by ${existing}`);
          seenTokens.set(share.magic_token!, key);
        });
      }
    }
  }

  // Check for orphaned shares (shares referencing non-existent or deleted docs)
  const activeSlugs = new Set(allDocs.filter(d => d.active).map(d => d.slug));
  for (const share of allShares) {
    if (!activeSlugs.has(share.document_slug)) {
      warn(`Orphaned share: ${share.email} on deleted/missing doc ${share.document_slug}`);
    }
  }

  db.close();
}

// --- API integration tests ---

async function testApiLogic() {
  const port = process.env.PORT;
  if (!port) {
    console.log('\n── API Tests (skipped — set PORT=4000 to enable) ──\n');
    return;
  }

  console.log('\n── API Logic Tests ──\n');

  const base = `http://localhost:${port}`;

  // We need a session cookie. Create a doc via the API (no auth needed for POST /documents)
  const slug = `test-share-${Date.now()}`;
  const domain = process.env.GOOGLE_ALLOWED_DOMAIN || 'cultivarium.org';

  // Create a test document
  const createRes = await fetch(`${base}/documents`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      slug,
      title: 'Sharing Logic Test',
      markdown: '# Test\nSharing logic test document.',
      author: 'test-runner',
    }),
  });

  if (!createRes.ok) {
    console.log('  ⚠ Could not create test document (might need auth). Skipping API tests.');
    return;
  }

  const createData = await createRes.json() as { ownerSecret?: string; accessToken?: string };
  const ownerToken = createData.ownerSecret || createData.accessToken || '';

  function authHeaders(extra: Record<string, string> = {}) {
    return { 'x-share-token': ownerToken, ...extra };
  }

  // Test: new document should be private by default
  test('new document defaults to private', async () => {
    const res = await fetch(`${base}/documents/${slug}/public-status`, { headers: authHeaders() });
    const data = await res.json() as { visibility: string };
    assertEqual(data.visibility, 'private');
  });

  // Test: adding an internal user auto-promotes private → selective
  test('adding internal user promotes private → selective', async () => {
    const res = await fetch(`${base}/documents/${slug}/shares`, {
      method: 'POST',
      headers: authHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ email: `testuser@${domain}`, role: 'viewer' }),
    });
    const data = await res.json() as { visibility: string; shares: Array<{ email: string; role: string }> };
    assertEqual(data.visibility, 'selective', 'Should auto-promote to selective');
    assert(data.shares.length >= 1, 'Should have at least one share');
  });

  // Test: adding another user stays selective
  test('adding more users stays selective', async () => {
    const res = await fetch(`${base}/documents/${slug}/shares`, {
      method: 'POST',
      headers: authHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ email: `another@${domain}`, role: 'editor' }),
    });
    const data = await res.json() as { visibility: string };
    assertEqual(data.visibility, 'selective');
  });

  // Test: switching to organization keeps people
  await fetch(`${base}/documents/${slug}/set-visibility`, {
    method: 'POST',
    headers: authHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ visibility: 'shared' }),
  });

  test('switching to organization keeps people', async () => {
    const res = await fetch(`${base}/documents/${slug}/public-status`, { headers: authHeaders() });
    const data = await res.json() as { visibility: string; shares: Array<unknown> };
    assertEqual(data.visibility, 'shared');
    assert(data.shares.length >= 2, 'Shares should be preserved');
  });

  // Test: adding people on organization stays organization
  test('adding people on organization stays organization', async () => {
    const res = await fetch(`${base}/documents/${slug}/shares`, {
      method: 'POST',
      headers: authHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ email: `third@${domain}`, role: 'commenter' }),
    });
    const data = await res.json() as { visibility: string };
    assertEqual(data.visibility, 'shared', 'Should stay on organization');
  });

  // Test: external user gets magic token
  test('external user gets magic token', async () => {
    const res = await fetch(`${base}/documents/${slug}/shares`, {
      method: 'POST',
      headers: authHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ email: 'external@gmail.com', role: 'viewer' }),
    });
    const data = await res.json() as { shares: Array<{ email: string; magic_token: string | null }> };
    const ext = data.shares.find(s => s.email === 'external@gmail.com');
    assert(!!ext, 'External share should exist');
    assert(!!ext!.magic_token, 'External user should have magic_token');
  });

  // Test: removing a share works
  test('removing share works', async () => {
    const res = await fetch(`${base}/documents/${slug}/shares/${encodeURIComponent('external@gmail.com')}`, {
      method: 'DELETE',
      headers: authHeaders(),
    });
    const data = await res.json() as { shares: Array<{ email: string }> };
    assert(!data.shares.find(s => s.email === 'external@gmail.com'), 'External share should be removed');
  });

  // Test: role validation
  test('invalid role defaults to viewer', async () => {
    const res = await fetch(`${base}/documents/${slug}/shares`, {
      method: 'POST',
      headers: authHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ email: `roletest@${domain}`, role: 'admin' }),
    });
    const data = await res.json() as { shares: Array<{ email: string; role: string }> };
    const share = data.shares.find(s => s.email === `roletest@${domain}`);
    assertEqual(share?.role, 'viewer', 'Invalid role should default to viewer');
  });

  // Cleanup: delete test document
  await fetch(`${base}/documents/${slug}/self-hosted-delete`, {
    method: 'POST',
    headers: authHeaders(),
  });

  console.log('  (test document cleaned up)');
}

// --- Main ---

async function main() {
  console.log('Sharing Logic Checker');
  console.log('=====================');

  await auditDatabase();
  await testApiLogic();

  console.log(`\n── Results: ${passed} passed, ${failed} failed, ${warnings} warnings ──\n`);
  if (failed > 0) process.exit(1);
}

main().catch((error) => {
  console.error('Fatal:', error);
  process.exit(1);
});
