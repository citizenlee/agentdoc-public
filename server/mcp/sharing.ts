/**
 * Per-user document sharing.
 * Adds a `document_shares` table for fine-grained access control by Google email address.
 * External users (non-domain) get a magic_token for link-based access.
 */
import { createHash } from 'crypto';
import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';

/** SHA-256 hash a magic token so raw tokens are never stored in the DB. */
function hashMagicToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let db: InstanceType<typeof Database> | null = null;

function getDb(): InstanceType<typeof Database> {
  if (!db) {
    const dbPath = process.env.DATABASE_PATH || path.join(__dirname, '..', '..', 'agentdoc.db');
    db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    db.pragma('busy_timeout = 5000');
    initTable();
  }
  return db;
}

function initTable(): void {
  getDb().exec(`
    CREATE TABLE IF NOT EXISTS document_shares (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      document_slug TEXT NOT NULL,
      email TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'viewer',
      granted_by TEXT,
      magic_token TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(document_slug, email)
    )
  `);

  // Add magic_token column if it doesn't exist (migration for existing DBs)
  try {
    getDb().exec(`ALTER TABLE document_shares ADD COLUMN magic_token TEXT`);
  } catch { /* column already exists */ }

  // Add expires_at column if it doesn't exist (migration for token expiration)
  try {
    getDb().exec(`ALTER TABLE document_shares ADD COLUMN expires_at TEXT`);
  } catch { /* column already exists */ }

  getDb().exec(`
    CREATE INDEX IF NOT EXISTS idx_document_shares_slug ON document_shares(document_slug)
  `);

  getDb().exec(`
    CREATE INDEX IF NOT EXISTS idx_document_shares_email ON document_shares(email)
  `);
}

export interface DocumentShare {
  id: number;
  document_slug: string;
  email: string;
  role: string;
  granted_by: string | null;
  magic_token: string | null;
  created_at: string;
  expires_at: string | null;
}

/**
 * Get all shares for a document.
 */
export function getDocumentShares(slug: string): DocumentShare[] {
  return getDb()
    .prepare('SELECT * FROM document_shares WHERE document_slug = ? AND (expires_at IS NULL OR expires_at > datetime(\'now\')) ORDER BY created_at')
    .all(slug) as DocumentShare[];
}

/**
 * Get all documents shared with a specific email.
 */
export function getDocumentsSharedWith(email: string): DocumentShare[] {
  return getDb()
    .prepare('SELECT * FROM document_shares WHERE email = ? ORDER BY created_at DESC')
    .all(email) as DocumentShare[];
}

/**
 * Check if a user has access to a document via the shares table.
 */
export function hasDocumentAccess(slug: string, email: string): boolean {
  const row = getDb()
    .prepare('SELECT 1 FROM document_shares WHERE document_slug = ? AND email = ? LIMIT 1')
    .get(slug, email);
  return !!row;
}

/**
 * Get a user's role for a document (from the shares table).
 */
export function getShareRole(slug: string, email: string): string | null {
  const row = getDb()
    .prepare('SELECT role FROM document_shares WHERE document_slug = ? AND email = ? LIMIT 1')
    .get(slug, email) as { role: string } | undefined;
  return row?.role || null;
}

/**
 * Add a share (upsert — updates role if already shared).
 * If magicToken is provided, it's stored for external users.
 */
export function addDocumentShare(
  slug: string,
  email: string,
  role: string = 'viewer',
  grantedBy?: string,
  magicToken?: string,
): void {
  // Hash the magic token before storage so raw tokens are never persisted.
  const hashedToken = magicToken ? hashMagicToken(magicToken) : null;
  // Default expiration: 90 days from now.
  const expiresAt = magicToken
    ? new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString()
    : null;
  getDb().prepare(`
    INSERT INTO document_shares (document_slug, email, role, granted_by, magic_token, expires_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(document_slug, email) DO UPDATE SET role = excluded.role, granted_by = excluded.granted_by
  `).run(slug, email, role, grantedBy || null, hashedToken, expiresAt);
}

/**
 * Look up a share by its magic token. Returns the share if found.
 */
export function getShareByMagicToken(token: string): DocumentShare | null {
  const hashedToken = hashMagicToken(token);

  // Primary lookup: hashed token, filtering out expired shares.
  let row = getDb()
    .prepare('SELECT * FROM document_shares WHERE magic_token = ? AND (expires_at IS NULL OR expires_at > datetime(\'now\')) LIMIT 1')
    .get(hashedToken) as DocumentShare | undefined;

  if (!row) {
    // Backward compat: try raw token lookup for legacy (pre-hashing) rows.
    row = getDb()
      .prepare('SELECT * FROM document_shares WHERE magic_token = ? AND (expires_at IS NULL OR expires_at > datetime(\'now\')) LIMIT 1')
      .get(token) as DocumentShare | undefined;

    if (row) {
      // Migrate legacy token to hashed form.
      getDb()
        .prepare('UPDATE document_shares SET magic_token = ? WHERE id = ?')
        .run(hashedToken, row.id);
      row.magic_token = hashedToken;
    }
  }

  return row || null;
}

/**
 * Remove a share.
 */
export function removeDocumentShare(slug: string, email: string): boolean {
  const result = getDb()
    .prepare('DELETE FROM document_shares WHERE document_slug = ? AND email = ?')
    .run(slug, email);
  return result.changes > 0;
}

/**
 * Remove all shares for a document.
 */
export function removeAllDocumentShares(slug: string): number {
  const result = getDb()
    .prepare('DELETE FROM document_shares WHERE document_slug = ?')
    .run(slug);
  return result.changes;
}
