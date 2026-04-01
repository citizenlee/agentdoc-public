import type { Request, Response, NextFunction, Router } from 'express';
import { randomBytes } from 'crypto';
import path from 'path';
import { fileURLToPath } from 'url';
import express from 'express';
import session from 'express-session';
import type { Store } from 'express-session';
import Database from 'better-sqlite3';
import { isDocumentPublic, getDocumentBySlug } from './db.js';
import { getShareByMagicToken } from './mcp/sharing.js';

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || '';
const SESSION_SECRET = process.env.SESSION_SECRET || randomBytes(32).toString('hex');
const ALLOWED_DOMAIN = process.env.GOOGLE_ALLOWED_DOMAIN || 'cultivarium.org';
const PUBLIC_URL = process.env.PUBLIC_URL || '';

const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GOOGLE_USERINFO_URL = 'https://www.googleapis.com/oauth2/v2/userinfo';

declare module 'express-session' {
  interface SessionData {
    user?: { email: string; name: string; picture: string };
    oauthState?: string;
  }
}

function getPublicUrl(req: Request): string {
  if (PUBLIC_URL) return PUBLIC_URL.replace(/\/$/, '');
  const proto = req.headers['x-forwarded-proto'] || req.protocol || 'http';
  const host = req.headers['x-forwarded-host'] || req.headers.host || 'localhost:4000';
  return `${proto}://${host}`;
}

function isAuthEnabled(): boolean {
  return !!(GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET);
}

/** Paths that skip authentication */
const PUBLIC_PATHS = [
  '/health',
  '/auth/',
  '/assets/',
  '/og/',
  '/share/',
  '/api/capabilities',
  '/install',
  '/skill',
  '/mcp',
  '/oauth/',
  '/.well-known/',
];

function isPublicPath(pathname: string): boolean {
  return PUBLIC_PATHS.some((p) => pathname === p || pathname.startsWith(p + '/'));
}

function isApiRequest(req: Request): boolean {
  // JSON-expecting clients (fetch, curl, etc.) get 401; browsers get redirect
  const accept = req.headers.accept || '';
  if (accept.includes('text/html')) return false;
  return (
    req.path.startsWith('/api/') ||
    req.path === '/documents' ||
    req.path.startsWith('/documents/') ||
    req.path.startsWith('/d/') ||
    req.path.startsWith('/ws')
  );
}

/** Simple SQLite-backed session store so sessions survive deploys */
class SqliteSessionStore extends session.Store {
  private db: InstanceType<typeof Database>;
  constructor() {
    super();
    const __dirname = path.dirname(fileURLToPath(import.meta.url));
    const dbPath = process.env.DATABASE_PATH || path.join(__dirname, '..', 'agentdoc.db');
    this.db = new Database(dbPath);
    this.db.exec(`CREATE TABLE IF NOT EXISTS sessions (
      sid TEXT PRIMARY KEY,
      data TEXT NOT NULL,
      expires INTEGER NOT NULL
    )`);
    // Clean expired sessions on startup
    this.db.exec(`DELETE FROM sessions WHERE expires < ${Math.floor(Date.now() / 1000)}`);
    // Periodically purge expired sessions every 30 minutes
    setInterval(() => {
      this.db.exec(`DELETE FROM sessions WHERE expires < ${Math.floor(Date.now() / 1000)}`);
    }, 30 * 60 * 1000);
  }
  get(sid: string, cb: (err?: Error | null, session?: session.SessionData | null) => void) {
    try {
      const row = this.db.prepare('SELECT data FROM sessions WHERE sid = ? AND expires > ?').get(sid, Math.floor(Date.now() / 1000)) as { data: string } | undefined;
      cb(null, row ? JSON.parse(row.data) : null);
    } catch (e) { cb(e as Error); }
  }
  set(sid: string, sess: session.SessionData, cb?: (err?: Error | null) => void) {
    try {
      const maxAge = sess.cookie?.maxAge || 7 * 24 * 60 * 60 * 1000;
      const expires = Math.floor((Date.now() + maxAge) / 1000);
      this.db.prepare('INSERT OR REPLACE INTO sessions (sid, data, expires) VALUES (?, ?, ?)').run(sid, JSON.stringify(sess), expires);
      cb?.();
    } catch (e) { cb?.(e as Error); }
  }
  destroy(sid: string, cb?: (err?: Error | null) => void) {
    try {
      this.db.prepare('DELETE FROM sessions WHERE sid = ?').run(sid);
      cb?.();
    } catch (e) { cb?.(e as Error); }
  }
}

/**
 * Search known domain users from sessions for autocomplete.
 * Extracts emails/names from stored session data.
 */
export function getKnownDomainUsers(query: string, domain: string): Array<{ email: string; name: string }> {
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const dbPath = process.env.DATABASE_PATH || path.join(__dirname, '..', 'agentdoc.db');
  const db = new Database(dbPath);
  try {
    const rows = db.prepare(
      'SELECT DISTINCT data FROM sessions WHERE expires > ? AND data LIKE ?'
    ).all(Math.floor(Date.now() / 1000), `%${query}%`) as Array<{ data: string }>;
    const seen = new Set<string>();
    const users: Array<{ email: string; name: string }> = [];
    for (const row of rows) {
      try {
        const sess = JSON.parse(row.data);
        const email = sess?.user?.email;
        if (!email || !email.endsWith('@' + domain) || seen.has(email)) continue;
        const lowerQuery = query.toLowerCase();
        const name = sess.user.name || email.split('@')[0];
        if (email.toLowerCase().includes(lowerQuery) || name.toLowerCase().includes(lowerQuery)) {
          seen.add(email);
          users.push({ email, name });
        }
      } catch { /* skip malformed session */ }
    }
    return users.slice(0, 10);
  } finally {
    db.close();
  }
}

export function createSessionMiddleware(): ReturnType<typeof session> {
  return session({
    store: new SqliteSessionStore(),
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
      secure: 'auto',
      httpOnly: true,
      maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
      sameSite: 'lax',
    },
  });
}

/** Extract document slug from common path patterns */
function extractSlugFromPath(pathname: string): string | null {
  // /d/:slug, /documents/:slug/...
  const dMatch = pathname.match(/^\/d\/([^/?]+)/);
  if (dMatch) return dMatch[1];
  const docMatch = pathname.match(/^\/documents\/([^/?]+)/);
  if (docMatch) return docMatch[1];
  return null;
}

/** Check if request is for a public document */
function isPublicDocumentRequest(req: Request): boolean {
  const slug = extractSlugFromPath(req.path);
  if (!slug) return false;
  try {
    const doc = getDocumentBySlug(slug);
    if (!doc) return false;
    return isDocumentPublic(slug);
  } catch {
    return false;
  }
}

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  if (!isAuthEnabled()) {
    next();
    return;
  }

  if (isPublicPath(req.path)) {
    next();
    return;
  }

  // Allow POST /documents (create) from API clients (Claude Code skill)
  if (req.method === 'POST' && req.path === '/documents') {
    next();
    return;
  }

  // Allow requests with Bearer token (validated downstream by agent-routes checkAuth)
  const authHeader = req.headers.authorization || '';
  if (authHeader.startsWith('Bearer ')) {
    next();
    return;
  }

  // Allow access to public documents without auth
  if (isPublicDocumentRequest(req)) {
    next();
    return;
  }

  // Allow tokenized document access (magic links for external users)
  const queryToken = typeof req.query.token === 'string' ? req.query.token.trim() : '';
  const headerToken = (req.header('x-share-token') || '').trim();
  if ((queryToken || headerToken) && extractSlugFromPath(req.path)) {
    next();
    return;
  }

  if (req.session?.user) {
    next();
    return;
  }

  // API requests get a 401 instead of redirect
  if (isApiRequest(req)) {
    res.status(401).json({ error: 'Authentication required. Sign in at /auth/google' });
    return;
  }

  // Browser requests redirect to Google OAuth.
  // Always force account picker so that after logout on a shared computer,
  // the next person must actively choose an account to sign in.
  res.redirect('/auth/google?prompt=1');
}

export function createAuthRoutes(): Router {
  const router = express.Router();

  router.get('/auth/google', (req: Request, res: Response) => {
    if (!isAuthEnabled()) {
      res.status(503).json({
        error: 'Google OAuth not configured. Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET.',
      });
      return;
    }

    const state = randomBytes(16).toString('hex');
    req.session.oauthState = state;

    const redirectUri = `${getPublicUrl(req)}/auth/google/callback`;
    const params = new URLSearchParams({
      client_id: GOOGLE_CLIENT_ID,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: 'openid email profile',
      state,
      hd: ALLOWED_DOMAIN, // Hint to Google to show only this domain
      ...(req.query.prompt ? { prompt: 'select_account' } : {}),
    });

    res.redirect(`${GOOGLE_AUTH_URL}?${params.toString()}`);
  });

  router.get('/auth/google/callback', async (req: Request, res: Response) => {
    const { code, state, error } = req.query;

    if (error) {
      res.type('text/plain').status(403).send(`Authentication failed: ${error}`);
      return;
    }

    if (!code || typeof code !== 'string') {
      res.status(400).send('Missing authorization code');
      return;
    }

    if (!state || state !== req.session.oauthState) {
      res.status(403).send('Invalid OAuth state — possible CSRF. Try again.');
      return;
    }
    delete req.session.oauthState;

    try {
      const redirectUri = `${getPublicUrl(req)}/auth/google/callback`;

      // Exchange code for tokens
      const tokenRes = await fetch(GOOGLE_TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          code,
          client_id: GOOGLE_CLIENT_ID,
          client_secret: GOOGLE_CLIENT_SECRET,
          redirect_uri: redirectUri,
          grant_type: 'authorization_code',
        }),
      });

      if (!tokenRes.ok) {
        const body = await tokenRes.text();
        console.error('[google-auth] token exchange failed:', body);
        res.status(502).send('Token exchange failed');
        return;
      }

      const tokens = (await tokenRes.json()) as { access_token: string };

      // Fetch user info
      const userRes = await fetch(GOOGLE_USERINFO_URL, {
        headers: { Authorization: `Bearer ${tokens.access_token}` },
      });

      if (!userRes.ok) {
        res.status(502).send('Failed to fetch user info');
        return;
      }

      const userInfo = (await userRes.json()) as {
        email: string;
        name: string;
        picture: string;
        hd?: string;
      };

      // Enforce domain restriction
      const emailDomain = userInfo.email.split('@')[1];
      if (emailDomain !== ALLOWED_DOMAIN) {
        res
          .status(403)
          .send(
            `Access denied. Only ${ALLOWED_DOMAIN} accounts are allowed. You signed in as ${userInfo.email}.`,
          );
        return;
      }

      // Regenerate session to prevent session fixation attacks
      const userData = { email: userInfo.email, name: userInfo.name, picture: userInfo.picture };
      req.session.regenerate((err) => {
        if (err) { res.status(500).send('Session error'); return; }
        req.session.user = userData;
        req.session.save(() => {
          res.redirect('/');
        });
      });
    } catch (err) {
      console.error('[google-auth] callback error:', err);
      res.status(500).send('Authentication error');
    }
  });

  router.get('/auth/logout', (req: Request, res: Response) => {
    // Determine if we're in a secure context so clearCookie attributes match
    // what the session middleware used when it set the cookie.
    const isSecure = req.secure || (req.headers['x-forwarded-proto'] || '').toString().split(',')[0]?.trim() === 'https';

    req.session.destroy(() => {
      // Clear the session cookie with matching attributes — if these don't match
      // (especially `secure`), the browser silently ignores the clear.
      res.clearCookie('connect.sid', {
        path: '/',
        httpOnly: true,
        sameSite: 'lax',
        secure: isSecure,
      });

      // Clear all per-document share and owner token cookies so the next user
      // on a shared computer cannot access documents from a previous session.
      const cookieHeader = req.headers.cookie || '';
      for (const part of cookieHeader.split(';')) {
        const name = part.trim().split('=')[0];
        if (name && (name.startsWith('agentdoc_share_token_') || name.startsWith('agentdoc_owner_token_') || name.startsWith('proof_share_token_') || name.startsWith('proof_owner_token_'))) {
          res.clearCookie(name, { path: '/', httpOnly: true, sameSite: 'lax', secure: isSecure });
        }
      }

      res.send(`<!doctype html><html><head><title>Signed out</title>
        <style>body{font-family:-apple-system,system-ui,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;color:#333}
        .box{text-align:center}a{color:#1a1a1a;font-size:13px}</style></head>
        <body><div class="box"><p>You have been signed out.</p><a href="/auth/google?prompt=1">Sign in again</a></div></body></html>`);
    });
  });

  router.get('/auth/me', (req: Request, res: Response) => {
    if (req.session?.user) {
      res.json({ authenticated: true, user: req.session.user });
      return;
    }
    // Check for magic link token identity
    const shareToken = (req.header('x-share-token') || '').trim();
    if (shareToken) {
      const share = getShareByMagicToken(shareToken);
      if (share) {
        res.json({ authenticated: true, user: { email: share.email, name: share.email.split('@')[0], picture: '' }, source: 'magic_link' });
        return;
      }
    }
    res.json({ authenticated: false });
  });

  return router;
}
