/**
 * SQLite-backed storage for MCP OAuth clients, authorization codes, and access tokens.
 * Uses the same database file as the main agentdoc server.
 */
import { randomBytes, randomUUID, createHash } from 'crypto';
import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let db: InstanceType<typeof Database> | null = null;

function getDb(): InstanceType<typeof Database> {
  if (!db) {
    const dbPath = process.env.DATABASE_PATH || path.join(__dirname, '..', '..', 'agentdoc.db');
    db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    db.pragma('busy_timeout = 5000');
    initTables();
  }
  return db;
}

function initTables(): void {
  const d = getDb();

  d.exec(`
    CREATE TABLE IF NOT EXISTS mcp_oauth_clients (
      client_id TEXT PRIMARY KEY,
      client_secret TEXT,
      client_secret_expires_at INTEGER,
      redirect_uris TEXT NOT NULL,
      client_name TEXT,
      client_id_issued_at INTEGER,
      metadata_json TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  d.exec(`
    CREATE TABLE IF NOT EXISTS mcp_oauth_codes (
      code TEXT PRIMARY KEY,
      client_id TEXT NOT NULL,
      redirect_uri TEXT NOT NULL,
      code_challenge TEXT NOT NULL,
      code_challenge_method TEXT DEFAULT 'S256',
      user_email TEXT NOT NULL,
      user_name TEXT NOT NULL,
      user_picture TEXT,
      scope TEXT,
      expires_at INTEGER NOT NULL,
      used INTEGER NOT NULL DEFAULT 0
    )
  `);

  d.exec(`
    CREATE TABLE IF NOT EXISTS mcp_oauth_tokens (
      token_hash TEXT PRIMARY KEY,
      token_prefix TEXT NOT NULL,
      client_id TEXT NOT NULL,
      user_email TEXT NOT NULL,
      user_name TEXT NOT NULL,
      user_picture TEXT,
      scope TEXT,
      expires_at INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  d.exec(`
    CREATE TABLE IF NOT EXISTS mcp_oauth_refresh_tokens (
      token_hash TEXT PRIMARY KEY,
      client_id TEXT NOT NULL,
      user_email TEXT NOT NULL,
      user_name TEXT NOT NULL,
      user_picture TEXT,
      scope TEXT,
      expires_at INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

// --- Client Store ---

export interface StoredClient {
  client_id: string;
  client_secret?: string;
  client_secret_expires_at?: number;
  redirect_uris: string[];
  client_name?: string;
  client_id_issued_at?: number;
  metadata_json?: string;
}

export function getClient(clientId: string): StoredClient | undefined {
  const row = getDb()
    .prepare('SELECT * FROM mcp_oauth_clients WHERE client_id = ?')
    .get(clientId) as (StoredClient & { redirect_uris: string }) | undefined;
  if (!row) return undefined;
  return {
    ...row,
    redirect_uris: JSON.parse(row.redirect_uris as string),
  };
}

export function registerClient(info: {
  redirect_uris: string[];
  client_name?: string;
  metadata_json?: string;
}): StoredClient {
  const clientId = `agentdoc_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
  const clientSecret = randomBytes(32).toString('hex');
  const issuedAt = Math.floor(Date.now() / 1000);

  getDb().prepare(`
    INSERT INTO mcp_oauth_clients (client_id, client_secret, redirect_uris, client_name, client_id_issued_at, metadata_json)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    clientId,
    clientSecret,
    JSON.stringify(info.redirect_uris),
    info.client_name || null,
    issuedAt,
    info.metadata_json || null,
  );

  return {
    client_id: clientId,
    client_secret: clientSecret,
    client_id_issued_at: issuedAt,
    redirect_uris: info.redirect_uris,
    client_name: info.client_name,
  };
}

// --- Authorization Code Store ---

export interface StoredAuthCode {
  code: string;
  client_id: string;
  redirect_uri: string;
  code_challenge: string;
  code_challenge_method: string;
  user_email: string;
  user_name: string;
  user_picture?: string;
  scope?: string;
  expires_at: number;
  used: number;
}

export function createAuthCode(params: {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  codeChallengeMethod?: string;
  userEmail: string;
  userName: string;
  userPicture?: string;
  scope?: string;
}): string {
  const code = randomBytes(32).toString('hex');
  const expiresAt = Math.floor(Date.now() / 1000) + 600; // 10 minutes

  getDb().prepare(`
    INSERT INTO mcp_oauth_codes (code, client_id, redirect_uri, code_challenge, code_challenge_method, user_email, user_name, user_picture, scope, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    code,
    params.clientId,
    params.redirectUri,
    params.codeChallenge,
    params.codeChallengeMethod || 'S256',
    params.userEmail,
    params.userName,
    params.userPicture || null,
    params.scope || null,
    expiresAt,
  );

  return code;
}

export function getAuthCode(code: string): StoredAuthCode | undefined {
  return getDb()
    .prepare('SELECT * FROM mcp_oauth_codes WHERE code = ?')
    .get(code) as StoredAuthCode | undefined;
}

export function markAuthCodeUsed(code: string): void {
  getDb().prepare('UPDATE mcp_oauth_codes SET used = 1 WHERE code = ?').run(code);
}

// --- Access Token Store ---

export interface StoredToken {
  token_hash: string;
  token_prefix: string;
  client_id: string;
  user_email: string;
  user_name: string;
  user_picture?: string;
  scope?: string;
  expires_at: number;
}

export function createAccessToken(params: {
  clientId: string;
  userEmail: string;
  userName: string;
  userPicture?: string;
  scope?: string;
}): { token: string; expiresIn: number } {
  const token = randomBytes(48).toString('hex');
  const expiresIn = 86400; // 24 hours
  const expiresAt = Math.floor(Date.now() / 1000) + expiresIn;

  getDb().prepare(`
    INSERT INTO mcp_oauth_tokens (token_hash, token_prefix, client_id, user_email, user_name, user_picture, scope, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    hashToken(token),
    token.slice(0, 8),
    params.clientId,
    params.userEmail,
    params.userName,
    params.userPicture || null,
    params.scope || null,
    expiresAt,
  );

  return { token, expiresIn };
}

export function verifyToken(token: string): StoredToken | undefined {
  const hash = hashToken(token);
  const now = Math.floor(Date.now() / 1000);
  return getDb()
    .prepare('SELECT * FROM mcp_oauth_tokens WHERE token_hash = ? AND expires_at > ?')
    .get(hash, now) as StoredToken | undefined;
}

export function revokeToken(token: string): void {
  const hash = hashToken(token);
  getDb().prepare('DELETE FROM mcp_oauth_tokens WHERE token_hash = ?').run(hash);
}

// --- Refresh Token Store ---

export function createRefreshToken(params: {
  clientId: string;
  userEmail: string;
  userName: string;
  userPicture?: string;
  scope?: string;
}): string {
  const token = randomBytes(48).toString('hex');
  const expiresAt = Math.floor(Date.now() / 1000) + 30 * 86400; // 30 days

  getDb().prepare(`
    INSERT INTO mcp_oauth_refresh_tokens (token_hash, client_id, user_email, user_name, user_picture, scope, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    hashToken(token),
    params.clientId,
    params.userEmail,
    params.userName,
    params.userPicture || null,
    params.scope || null,
    expiresAt,
  );

  return token;
}

export function verifyRefreshToken(token: string): StoredToken | undefined {
  const hash = hashToken(token);
  const now = Math.floor(Date.now() / 1000);
  return getDb()
    .prepare('SELECT token_hash, client_id, user_email, user_name, user_picture, scope, expires_at FROM mcp_oauth_refresh_tokens WHERE token_hash = ? AND expires_at > ?')
    .get(hash, now) as StoredToken | undefined;
}

export function revokeRefreshToken(token: string): void {
  const hash = hashToken(token);
  getDb().prepare('DELETE FROM mcp_oauth_refresh_tokens WHERE token_hash = ?').run(hash);
}

/**
 * Rotate a refresh token: verify the old one, revoke it, and issue a new one.
 * This prevents replay attacks — each refresh token can only be used once.
 * Returns the verified token data and a new refresh token, or undefined if invalid.
 */
export function rotateRefreshToken(oldToken: string): { stored: StoredToken; newRefreshToken: string } | undefined {
  const stored = verifyRefreshToken(oldToken);
  if (!stored) return undefined;

  // Invalidate the old refresh token immediately
  revokeRefreshToken(oldToken);

  // Issue a replacement refresh token
  const newRefreshToken = createRefreshToken({
    clientId: stored.client_id,
    userEmail: stored.user_email,
    userName: stored.user_name,
    userPicture: stored.user_picture,
    scope: stored.scope,
  });

  return { stored, newRefreshToken };
}

// --- Cleanup ---

export function cleanupExpiredTokens(): number {
  const now = Math.floor(Date.now() / 1000);
  const r1 = getDb().prepare('DELETE FROM mcp_oauth_tokens WHERE expires_at < ?').run(now);
  const r2 = getDb().prepare('DELETE FROM mcp_oauth_codes WHERE expires_at < ?').run(now);
  const r3 = getDb().prepare('DELETE FROM mcp_oauth_refresh_tokens WHERE expires_at < ?').run(now);
  return r1.changes + r2.changes + r3.changes;
}
