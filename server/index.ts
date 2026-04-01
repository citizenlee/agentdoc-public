import express from 'express';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import path from 'path';
import { fileURLToPath } from 'url';
import compression from 'compression';
import { env } from './env.js';
import { apiRoutes } from './routes.js';
import { agentRoutes } from './agent-routes.js';
import { deleteDocument, getDocumentBySlug, getDocumentVisibility, setDocumentVisibility, getDocumentOwnerEmail, setDocumentOwnerEmail, canMutateByOwnerIdentity, setDocumentArchived, isDocumentArchived, listDocumentVersions, getDocumentVersion, saveDocumentVersion, recordDocumentView, getDocumentViewCount, getDocumentViewHistory, getDocumentRecentViewers, createDocumentAccessToken } from './db.js';
import type { DocumentVisibility } from './db.js';
import { setupWebSocket, closeRoom } from './ws.js';
import { createBridgeMountRouter } from './bridge.js';
import { getCollabRuntime, startCollabRuntimeEmbedded, invalidateCollabDocument } from './collab.js';
import { discoveryRoutes } from './discovery-routes.js';
import { shareWebRoutes } from './share-web-routes.js';
import {
  capabilitiesPayload,
  enforceApiClientCompatibility,
  enforceBridgeClientCompatibility,
} from './client-capabilities.js';
import { getBuildInfo } from './build-info.js';
import { createSessionMiddleware, requireAuth, createAuthRoutes } from './google-auth.js';
import { mountMcp } from './mcp/index.js';
import { getDocumentShares, addDocumentShare, removeDocumentShare, getShareByMagicToken } from './mcp/sharing.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PORT = Number.parseInt(process.env.PORT || '4000', 10);
// 'null' origin was removed: it matches requests from sandboxed iframes, data:
// URIs, and file:// pages. Allowing it would let any of those contexts make
// credentialed cross-origin requests to the server.
const DEFAULT_ALLOWED_CORS_ORIGINS = [
  'http://localhost:3000',
  'http://127.0.0.1:3000',
  'http://localhost:4000',
  'http://127.0.0.1:4000',
];

function parseAllowedCorsOrigins(): Set<string> {
  const configured = (env('AGENTDOC_CORS_ALLOW_ORIGINS', 'PROOF_CORS_ALLOW_ORIGINS') || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  return new Set(configured.length > 0 ? configured : DEFAULT_ALLOWED_CORS_ORIGINS);
}

async function main(): Promise<void> {
  const app = express();
  app.disable('x-powered-by');
  const server = createServer(app);
  server.headersTimeout = 30000;
  server.requestTimeout = 60000;
  server.keepAliveTimeout = 5000;
  const wss = new WebSocketServer({ server, path: '/ws' });
  const allowedCorsOrigins = parseAllowedCorsOrigins();

  app.set('trust proxy', 1);

  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('X-XSS-Protection', '0');
    next();
  });

  app.use(compression());
  app.use(express.json({ limit: '10mb' }));
  app.use(express.static(path.join(__dirname, '..', 'public'), { maxAge: '1h', etag: true }));
  app.use(express.static(path.join(__dirname, '..', 'dist'), { maxAge: '1h', etag: true }));

  app.use((req, res, next) => {
    const originHeader = req.header('origin');
    if (originHeader && allowedCorsOrigins.has(originHeader)) {
      res.setHeader('Access-Control-Allow-Origin', originHeader);
      res.setHeader('Vary', 'Origin');
    }
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
    res.setHeader(
      'Access-Control-Allow-Headers',
      [
        'Content-Type',
        'Authorization',
        'X-Agentdoc-Client-Version',
        'X-Agentdoc-Client-Build',
        'X-Agentdoc-Client-Protocol',
        'x-share-token',
        'x-bridge-token',
        'x-auth-poll-token',
        'X-Agent-Id',
        'X-Window-Id',
        'X-Document-Id',
        'Idempotency-Key',
        'X-Idempotency-Key',
      ].join(', '),
    );
    if (req.method === 'OPTIONS') {
      res.status(204).end();
      return;
    }
    next();
  });

  // MCP server (has its own OAuth, must be mounted before session middleware)
  mountMcp(app);

  // Google OAuth: session + auth routes + gate
  app.use(createSessionMiddleware());
  app.use(createAuthRoutes());
  app.use(requireAuth);

  app.get('/', (_req, res) => {
    res.setHeader('Link', '</documents>; rel=preload; as=fetch; crossorigin');
    res.type('html').send(`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>AgentDoc</title>
    <style>
      * { margin: 0; padding: 0; box-sizing: border-box; }
      body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif; background: #fff; color: #1a1a1a; }
      header {
        height: 44px; display: flex; align-items: center; justify-content: space-between;
        padding: 0 24px; border-bottom: 1px solid #f0f0f0;
      }
      header h1 { font-size: 14px; font-weight: 600; }
      .header-right { display: flex; align-items: center; gap: 12px; }
      .user-info { font-size: 12px; color: #888; }
      .user-info a { color: #888; text-decoration: none; }
      .user-info a:hover { color: #555; text-decoration: underline; }
      .new-btn {
        padding: 6px 14px; border-radius: 5px; border: none;
        background: #1a1a1a; color: #fff; cursor: pointer; font-size: 13px;
      }
      .new-btn:hover { background: #333; }
      html { overflow-y: scroll; }
      main { max-width: 1060px; margin: 0 auto; padding: 32px 24px; }
      .filter-bar { display: flex; gap: 6px; margin-bottom: 20px; flex-wrap: wrap; align-items: center; }
      .search-input {
        padding: 5px 12px; border-radius: 20px; border: 1.5px solid #e0e0e0;
        background: #fff; font-size: 12px; font-weight: 400; color: #333;
        outline: none; width: 180px; transition: border-color 0.15s, width 0.2s;
        font-family: inherit;
      }
      .search-input:focus { border-color: #999; width: 220px; }
      .search-input::placeholder { color: #bbb; }
      .search-wrap { position: relative; display: inline-flex; align-items: center; }
      .search-clear {
        position: absolute; right: 8px; top: 50%; transform: translateY(-50%);
        width: 16px; height: 16px; border: none; background: #ddd; color: #666;
        border-radius: 50%; cursor: pointer; font-size: 10px; line-height: 16px;
        text-align: center; padding: 0; display: none;
      }
      .search-clear:hover { background: #ccc; color: #333; }
      .search-wrap.has-text .search-clear { display: block; }
      .search-wrap.has-text .search-input { padding-right: 28px; }
      .sortable { cursor: pointer; user-select: none; }
      .sortable:hover { color: #888; }
      .sort-arrow { font-size: 8px; color: #aaa; }
      .filter-btn {
        padding: 5px 14px; border-radius: 20px; border: 1.5px solid #e0e0e0;
        background: #fff; cursor: pointer; font-size: 12px; font-weight: 500;
        color: #888; transition: all 0.15s;
      }
      .filter-btn:hover { border-color: #bbb; color: #555; }
      .filter-btn.active-all { background: #1a1a1a; color: #fff; border-color: #1a1a1a; }
      .filter-btn.active-private { background: #ef4444; color: #fff; border-color: #ef4444; }
      .filter-btn.active-selective { background: #f97316; color: #fff; border-color: #f97316; }
      .filter-btn.active-shared { background: #ffd600; color: #1a1a1a; border-color: #ffd600; }
      .filter-btn.active-public { background: #22c55e; color: #fff; border-color: #22c55e; }
      .filter-btn.active-archived { background: #b45309; color: #fff; border-color: #b45309; }
      .doc-list { list-style: none; }
      .doc-header {
        display: grid;
        grid-template-columns: 16px 1fr 110px 50px 110px 110px 110px 55px 50px;
        gap: 12px; align-items: center;
        padding: 6px 0; border-bottom: 1px solid #eee;
        font-size: 9px; text-transform: uppercase; letter-spacing: 0.4px; color: #bbb; font-weight: 600;
      }
      .doc-item {
        display: grid;
        grid-template-columns: 16px 1fr 110px 50px 110px 110px 110px 55px 50px;
        gap: 12px; align-items: center;
        padding: 10px 0; border-bottom: 1px solid #f5f5f5; cursor: pointer;
      }
      .doc-item:hover { background: #fafafa; margin: 0 -12px; padding: 10px 12px; border-radius: 6px; }
      .visibility-dots { display: flex; align-items: center; flex-shrink: 0; width: 16px; }
      .visibility-dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }
      .visibility-dot.secondary { margin-left: -3px; }
      .visibility-dot.private { background: #ef4444; }
      .visibility-dot.selective { background: #f97316; }
      .visibility-dot.shared { background: #ffd600; }
      .visibility-dot.public { background: #22c55e; }
      .doc-title { font-size: 14px; font-weight: 500; color: #1a1a1a; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; }
      @media (max-width: 768px) {
        .doc-header { display: none; }
        .doc-item {
          grid-template-columns: 16px 1fr;
          gap: 8px;
        }
        .doc-author, .doc-views, .doc-time, .doc-archive, .doc-delete { display: none; }
        .doc-title { white-space: normal; word-break: break-word; font-size: 15px; line-height: 1.4; }
      }
      .doc-author { color: #888; font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .doc-views { font-size: 12px; color: #aaa; text-align: center; }
      .doc-time { font-size: 11px; color: #aaa; white-space: nowrap; }
      .doc-archive {
        padding: 4px 8px; border: none; background: none; color: #ccc;
        cursor: pointer; font-size: 11px; border-radius: 4px;
        transition: all 0.15s; text-align: center;
      }
      .doc-archive:hover { color: #b45309; background: #fffbeb; }
      .doc-archive.is-archived { color: #b45309; }
      .doc-delete {
        padding: 4px 8px; border: none; background: none; color: #ccc;
        cursor: pointer; font-size: 12px; border-radius: 4px;
        transition: all 0.15s; text-align: center;
      }
      .doc-delete:hover { color: #e55; background: #fef2f2; }
      .confirm-modal {
        position: fixed; inset: 0; background: rgba(0,0,0,0.3);
        display: flex; align-items: center; justify-content: center; z-index: 100;
      }
      .confirm-box {
        background: #fff; padding: 24px; border-radius: 8px; max-width: 360px;
        box-shadow: 0 4px 20px rgba(0,0,0,0.15); text-align: center;
      }
      .confirm-box p { font-size: 14px; color: #333; margin-bottom: 16px; line-height: 1.5; }
      .confirm-box .confirm-title { font-weight: 600; margin-bottom: 4px; }
      .confirm-actions { display: flex; gap: 8px; justify-content: center; }
      .confirm-actions button {
        padding: 8px 16px; border-radius: 5px; font-size: 13px; cursor: pointer;
      }
      .confirm-cancel { border: 1px solid #ddd; background: #fff; color: #555; }
      .confirm-cancel:hover { background: #f7f7f7; }
      .confirm-delete { border: none; background: #e55; color: #fff; }
      .confirm-delete:hover { background: #d44; }
      .empty { text-align: center; padding: 60px 0; color: #bbb; font-size: 14px; }
      #status { text-align: center; padding: 20px; color: #aaa; font-size: 13px; }
    </style>
  </head>
  <body>
    <header>
      <h1>AgentDoc</h1>
      <div class="header-right">
        <span class="user-info" id="user-info"></span>
        <button class="new-btn" onclick="createDoc()">New Document</button>
      </div>
    </header>
    <main>
      <div class="filter-bar" id="filter-bar">
        <span class="search-wrap" id="search-wrap"><input class="search-input" id="search-input" type="text" placeholder="Search documents..." oninput="onSearch(this.value)" onkeydown="if(event.key==='Escape')clearSearch()"><button class="search-clear" onclick="clearSearch()" title="Clear search">&times;</button></span>
        <button class="filter-btn active-all" data-filter="all" onclick="setFilter('all')">All</button>
        <button class="filter-btn" data-filter="private" onclick="setFilter('private')">Private</button>
        <button class="filter-btn" data-filter="selective" onclick="setFilter('selective')">Selective</button>
        <button class="filter-btn" data-filter="shared" onclick="setFilter('shared')">Organization</button>
        <button class="filter-btn" data-filter="public" onclick="setFilter('public')">Public</button>
        <button class="filter-btn" data-filter="archived" onclick="setFilter('archived')">Archived</button>
      </div>
      <div class="doc-header">
        <span></span>
        <span class="sortable" onclick="toggleSort('title')">Title <span class="sort-arrow" id="sort-title"></span></span>
        <span class="sortable" onclick="toggleSort('author')">Author <span class="sort-arrow" id="sort-author"></span></span>
        <span class="sortable" onclick="toggleSort('views')" style="text-align:center">Views <span class="sort-arrow" id="sort-views"></span></span>
        <span class="sortable" onclick="toggleSort('created')">Created <span class="sort-arrow" id="sort-created"></span></span>
        <span class="sortable" onclick="toggleSort('modified')">Modified <span class="sort-arrow" id="sort-modified"></span></span>
        <span class="sortable" onclick="toggleSort('lastViewed')">Last Viewed <span class="sort-arrow" id="sort-lastViewed"></span></span>
        <span></span>
        <span></span>
      </div>
      <div id="status">Loading...</div>
      <ul class="doc-list" id="doc-list"></ul>
    </main>
    <script>
      let allDocs = [];
      let currentFilter = 'all';
      let searchQuery = '';
      let sortColumn = null;
      let sortAsc = true;

      function toggleSort(col) {
        if (sortColumn === col) { sortAsc = !sortAsc; }
        else { sortColumn = col; sortAsc = true; }
        document.querySelectorAll('.sort-arrow').forEach(el => el.textContent = '');
        var arrow = document.getElementById('sort-' + col);
        if (arrow) arrow.textContent = sortAsc ? '\\u25B2' : '\\u25BC';
        renderDocs();
      }

      function sortDocs(arr) {
        if (!sortColumn) return arr;
        var col = sortColumn;
        var sorted = arr.slice().sort(function(a, b) {
          var va, vb;
          if (col === 'title') { va = (a.title || '').toLowerCase(); vb = (b.title || '').toLowerCase(); }
          else if (col === 'author') {
            va = (a.author || '').toLowerCase(); vb = (b.author || '').toLowerCase();
            if (va === vb) { va = (a.title || '').toLowerCase(); vb = (b.title || '').toLowerCase(); }
          }
          else if (col === 'views') { va = a.viewCount || 0; vb = b.viewCount || 0; }
          else if (col === 'created') { va = a.createdAt || ''; vb = b.createdAt || ''; }
          else if (col === 'modified') { va = a.updatedAt || ''; vb = b.updatedAt || ''; }
          else if (col === 'lastViewed') { va = a.lastViewedAt || ''; vb = b.lastViewedAt || ''; }
          else { va = ''; vb = ''; }
          if (va < vb) return sortAsc ? -1 : 1;
          if (va > vb) return sortAsc ? 1 : -1;
          return 0;
        });
        return sorted;
      }

      function setFilter(f) {
        currentFilter = f;
        document.querySelectorAll('.filter-btn').forEach(btn => {
          btn.className = 'filter-btn' + (btn.dataset.filter === f ? ' active-' + f : '');
        });
        renderDocs();
      }

      function onSearch(q) {
        searchQuery = q.toLowerCase().trim();
        document.getElementById('search-wrap').className = 'search-wrap' + (q ? ' has-text' : '');
        if (searchQuery && currentFilter !== 'all' && currentFilter !== 'archived') {
          setFilter('all');
          return;
        }
        renderDocs();
      }

      function clearSearch() {
        var input = document.getElementById('search-input');
        input.value = '';
        searchQuery = '';
        document.getElementById('search-wrap').className = 'search-wrap';
        input.blur();
        renderDocs();
      }

      function matchesFilter(d, f) {
        if (f === 'all') return !d.archived;
        if (f === 'archived') return d.archived;
        if (f === 'selective') return !d.archived && (d.visibility === 'selective' || d.hasShares);
        return !d.archived && d.visibility === f;
      }

      function matchesSearch(d) {
        if (!searchQuery) return true;
        var t = (d.title || '').toLowerCase();
        var a = (d.author || '').toLowerCase();
        return t.indexOf(searchQuery) !== -1 || a.indexOf(searchQuery) !== -1;
      }

      function renderDocs() {
        const list = document.getElementById('doc-list');
        const status = document.getElementById('status');
        let filtered = sortDocs(allDocs.filter(d => matchesFilter(d, currentFilter) && matchesSearch(d)));
        if (allDocs.length === 0) {
          status.innerHTML = '<div class="empty">No documents yet. Create one to get started.</div>';
          status.style.display = '';
          list.innerHTML = '';
          return;
        }
        if (filtered.length === 0) {
          status.innerHTML = '<div class="empty">No ' + currentFilter + ' documents.</div>';
          status.style.display = '';
          list.innerHTML = '';
          return;
        }
        status.style.display = 'none';
        list.innerHTML = filtered.map(d => {
          const created = d.createdAt ? fmtTime(d.createdAt) : '';
          const modified = d.updatedAt ? fmtTime(d.updatedAt) : '';
          const lastViewed = d.lastViewedAt ? fmtTime(d.lastViewedAt) : '\\u2014';
          const author = d.author ? esc(formatAuthor(d.author)) : '';
          const vis = d.visibility || 'private';
          const views = d.viewCount || 0;
          const archiveLabel = d.archived ? 'Unarchive' : 'Archive';
          const archiveClass = d.archived ? 'doc-archive is-archived' : 'doc-archive';
          var dots = '<span class="visibility-dot ' + vis + '"></span>';
          if (d.hasShares && vis !== 'selective' && vis !== 'private') {
            dots += '<span class="visibility-dot selective secondary"></span>';
          }
          var dotTitle = vis.charAt(0).toUpperCase() + vis.slice(1);
          if (d.hasShares && vis !== 'selective' && vis !== 'private') dotTitle += ' + Selective';
          return '<li class="doc-item" onclick="window.location.href=\\'/d/' + d.slug + '\\'"><span class="visibility-dots" title="' + dotTitle + '">' + dots + '</span><span class="doc-title" ondblclick="event.stopPropagation();renameDoc(\\'' + d.slug + '\\',this)">' + esc(d.title) + '</span><span class="doc-author">' + author + '</span><span class="doc-views">' + views + '</span><span class="doc-time">' + created + '</span><span class="doc-time">' + modified + '</span><span class="doc-time">' + lastViewed + '</span><button class="' + archiveClass + '" onclick="event.stopPropagation();toggleArchive(\\'' + d.slug + '\\')">' + archiveLabel + '</button><button class="doc-delete" onclick="event.stopPropagation();confirmDelete(\\'' + d.slug + '\\',\\'' + esc(d.title).replace(/'/g, "\\\\'") + '\\')">Delete</button></li>';
        }).join('');
      }

      async function loadDocs() {
        try {
          const res = await fetch('/documents');
          if (!res.ok) throw new Error(res.status);
          allDocs = await res.json();
          renderDocs();
        } catch (e) {
          document.getElementById('status').textContent = 'Failed to load documents';
        }
      }
      function getAuthorName() {
        if (oauthUser && oauthUser.name) return 'oauth_user:' + oauthUser.name;
        let name = localStorage.getItem('cultivarium_author');
        if (!name) {
          name = prompt('Enter your name (used as document author):');
          if (name && name.trim()) {
            localStorage.setItem('cultivarium_author', name.trim());
          }
        }
        return (name || '').trim();
      }
      async function createDoc() {
        const author = getAuthorName();
        if (!author) return;
        try {
          const res = await fetch('/documents', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ markdown: '# Untitled\\n\\nStart writing here.', ownerId: author }),
          });
          const data = await res.json();
          if (data.slug) {
            window.location.href = '/d/' + data.slug + (data.accessToken ? '?token=' + data.accessToken : '');
          }
        } catch (e) {
          alert('Failed to create document');
        }
      }
      function esc(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }
      function formatAuthor(a) { return a.replace(/^(ai:|agent:|user:|oauth_user:|oauth:)/, ''); }
      async function renameDoc(slug, el) {
        const current = el.textContent;
        const newTitle = prompt('Rename document:', current);
        if (!newTitle || newTitle.trim() === current) return;
        try {
          const res = await fetch('/documents/' + slug + '/title', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ title: newTitle.trim() })
          });
          if (res.ok) { el.textContent = newTitle.trim(); }
          else { alert('Rename failed'); }
        } catch (e) { alert('Rename failed'); }
      }
      function fmtTime(iso) {
        const d = new Date(iso);
        return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'America/New_York' }) + ' ' + d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York' });
      }
      function confirmDelete(slug, title) {
        const modal = document.createElement('div');
        modal.className = 'confirm-modal';
        modal.innerHTML = '<div class="confirm-box"><p class="confirm-title">Delete document?</p><p>' + esc(title) + '</p><div class="confirm-actions"><button class="confirm-cancel" onclick="this.closest(\\'.confirm-modal\\').remove()">Cancel</button><button class="confirm-delete" onclick="doDelete(\\'' + slug + '\\',this.closest(\\'.confirm-modal\\'))">Delete</button></div></div>';
        document.body.appendChild(modal);
        modal.addEventListener('click', (e) => { if (e.target === modal) modal.remove(); });
      }
      async function doDelete(slug, modal) {
        try {
          const res = await fetch('/documents/' + slug + '/self-hosted-delete', { method: 'POST' });
          if (res.ok) { modal.remove(); loadDocs(); }
          else { alert('Failed to delete'); }
        } catch (e) { alert('Failed to delete'); }
      }
      async function toggleArchive(slug) {
        try {
          const res = await fetch('/documents/' + slug + '/toggle-archive', { method: 'POST' });
          if (res.ok) { loadDocs(); }
          else { alert('Failed to update archive status'); }
        } catch (e) { alert('Failed to update archive status'); }
      }
      let oauthUser = null;
      async function loadAuth() {
        try {
          const res = await fetch('/auth/me');
          const data = await res.json();
          if (data.authenticated && data.user) {
            oauthUser = data.user;
            document.getElementById('user-info').innerHTML =
              esc(data.user.name) + ' &middot; <a href="/auth/logout">Sign out</a>';
          }
        } catch (e) {}
      }
      loadAuth();
      loadDocs();
    </script>
  </body>
</html>`);
  });

  app.get('/health', (_req, res) => {
    const buildInfo = getBuildInfo();
    res.json({
      ok: true,
      buildInfo,
      collab: getCollabRuntime(),
    });
  });

  app.get('/api/capabilities', (_req, res) => {
    res.json(capabilitiesPayload());
  });

  // Serve skill file for installation
  app.get('/skill', (_req, res) => {
    res.type('text/plain').sendFile(path.join(__dirname, '..', 'SKILL.md'));
  });

  // Install page with instructions
  app.get(['/install', '/installation'], (_req, res) => {
    res.type('html').send(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Install AgentDoc</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif; background: #fff; color: #1a1a1a; display: flex; justify-content: center; padding: 60px 24px; }
    .container { max-width: 660px; width: 100%; }
    h1 { font-size: 24px; font-weight: 600; margin-bottom: 8px; }
    .subtitle { color: #888; font-size: 14px; margin-bottom: 32px; }
    h2 { font-size: 14px; font-weight: 600; margin-bottom: 8px; color: #555; }
    .step { margin-bottom: 28px; }
    .step p { font-size: 14px; line-height: 1.6; color: #444; margin-bottom: 8px; }
    .code-block { position: relative; background: #1a1a1a; color: #e0e0e0; padding: 14px 16px; border-radius: 8px; font-family: 'SF Mono', Menlo, monospace; font-size: 13px; line-height: 1.5; overflow-x: auto; white-space: pre-wrap; word-break: break-all; }
    .copy-btn { position: absolute; top: 8px; right: 8px; background: #333; color: #ccc; border: none; border-radius: 4px; padding: 4px 10px; font-size: 11px; cursor: pointer; }
    .copy-btn:hover { background: #444; color: #fff; }
    .or { text-align: center; color: #bbb; font-size: 12px; margin: 20px 0; }
    .note { font-size: 12px; color: #999; margin-top: 32px; line-height: 1.5; }
    .note a { color: #888; }
    .section-label { display: inline-block; font-size: 10px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px; padding: 3px 8px; border-radius: 4px; margin-bottom: 16px; }
    .label-recommended { background: #dcfce7; color: #166534; }
    .label-skill { background: #fef3c7; color: #92400e; }
    .divider { border: none; border-top: 1px solid #eee; margin: 36px 0; }
  </style>
</head>
<body>
  <div class="container">
    <h1>AgentDoc</h1>
    <p class="subtitle">Read, write, and share documents from Claude Code with Google OAuth authentication.</p>

    <span class="section-label label-recommended">Recommended</span>
    <h2>MCP Server (full integration)</h2>
    <p>Adds native tools for reading, writing, and sharing documents. Authenticates with your Google account so Claude knows who you are.</p>

    <div class="step">
      <h2>One-liner install</h2>
      <p>Run this in your terminal:</p>
      <div class="code-block" id="cmd-mcp">claude mcp add --transport http -s user agentdoc https://agentdoc.up.railway.app/mcp<button class="copy-btn" onclick="navigator.clipboard.writeText(document.getElementById('cmd-mcp').childNodes[0].textContent);this.textContent='Copied!';setTimeout(()=>this.textContent='Copy',1500)">Copy</button></div>
    </div>

    <div class="step">
      <h2>Auto-approve tools (optional)</h2>
      <p>So you don't have to confirm each tool call:</p>
      <div class="code-block" id="cmd-perm">claude settings add-permission 'mcp__agentdoc__*'<button class="copy-btn" onclick="navigator.clipboard.writeText(document.getElementById('cmd-perm').childNodes[0].textContent);this.textContent='Copied!';setTimeout(()=>this.textContent='Copy',1500)">Copy</button></div>
    </div>

    <div class="step">
      <h2>What you get</h2>
      <p>After install, Claude Code can:</p>
      <ul style="font-size: 14px; color: #444; padding-left: 20px; line-height: 2;">
        <li><strong>Read documents</strong> \u2014 paste an agentdoc link and Claude can read it</li>
        <li><strong>Create documents</strong> \u2014 "write this as an agentdoc"</li>
        <li><strong>Edit documents</strong> \u2014 update content, title, or visibility</li>
        <li><strong>Share with specific people</strong> \u2014 by Google email address</li>
        <li><strong>List your documents</strong> \u2014 owned, shared with you, or all</li>
      </ul>
      <p style="margin-top: 8px;">On first use, your browser will open for Google sign-in. Tokens are cached automatically.</p>
    </div>

    <hr class="divider">

    <span class="section-label label-skill">Alternative</span>
    <h2>Skill only (write-only, no auth)</h2>
    <p>If you just want to create documents without authentication:</p>

    <div class="step">
      <div class="code-block" id="cmd-skill">mkdir -p ~/.claude/skills/agentdoc && curl -sS https://agentdoc.up.railway.app/skill > ~/.claude/skills/agentdoc/SKILL.md && echo "AgentDoc skill installed"<button class="copy-btn" onclick="navigator.clipboard.writeText(document.getElementById('cmd-skill').childNodes[0].textContent);this.textContent='Copied!';setTimeout(()=>this.textContent='Copy',1500)">Copy</button></div>
    </div>

    <div class="or">or paste into Claude Code:</div>

    <div class="step">
      <div class="code-block" id="cmd-skill2">Fetch https://agentdoc.up.railway.app/skill and save it to ~/.claude/skills/agentdoc/SKILL.md<button class="copy-btn" onclick="navigator.clipboard.writeText(document.getElementById('cmd-skill2').childNodes[0].textContent);this.textContent='Copied!';setTimeout(()=>this.textContent='Copy',1500)">Copy</button></div>
      <p style="margin-top: 8px;">Then use: <code>"write this as an agentdoc"</code> or <code>/agentdoc</code></p>
    </div>

    <p class="note">Documents are private by default. The owner can share with specific people, the whole org, or make public. MCP server requires a Cultivarium Google account.</p>
  </div>
</body>
</html>`);
  });

  // Self-hosted routes (no owner secret required)
  if (env('AGENTDOC_SELF_HOSTED', 'PROOF_SELF_HOSTED') === '1') {
    app.post('/documents/:slug/self-hosted-delete', (req, res) => {
      const slug = req.params.slug;
      const doc = getDocumentBySlug(slug);
      if (!doc) { res.status(404).json({ error: 'Document not found' }); return; }
      const ownerEmail = getDocumentOwnerEmail(slug);
      if (!req.session?.user?.email || req.session.user.email !== ownerEmail) {
        res.status(403).json({ error: 'Only the document owner can delete this document' });
        return;
      }
      deleteDocument(slug);
      invalidateCollabDocument(slug);
      closeRoom(slug);
      res.json({ success: true, shareState: 'DELETED' });
    });

    app.post('/documents/:slug/toggle-public', (req, res) => {
      const slug = req.params.slug;
      const doc = getDocumentBySlug(slug);
      if (!doc) { res.status(404).json({ error: 'Document not found' }); return; }
      if (!req.session?.user) {
        res.status(403).json({ error: 'You must be signed in to change document visibility' });
        return;
      }
      // Only the document owner can change visibility
      const ownerEmail = getDocumentOwnerEmail(slug);
      if (!ownerEmail || req.session.user.email !== ownerEmail) {
        res.status(403).json({ error: 'Only the document owner can change visibility' });
        return;
      }
      const current = getDocumentVisibility(slug);
      const cycle: Record<string, DocumentVisibility> = { private: 'selective', selective: 'shared', shared: 'public', public: 'private' };
      const next = cycle[current] || 'private';
      setDocumentVisibility(slug, next);
      res.json({ success: true, isPublic: next === 'public', visibility: next });
    });

    app.post('/documents/:slug/set-visibility', (req, res) => {
      const slug = req.params.slug;
      const doc = getDocumentBySlug(slug);
      if (!doc) { res.status(404).json({ error: 'Document not found' }); return; }
      const { visibility } = req.body;
      if (!['private', 'selective', 'shared', 'public'].includes(visibility)) {
        res.status(400).json({ error: 'Invalid visibility. Must be private, selective, shared, or public.' });
        return;
      }
      if (!req.session?.user) {
        res.status(403).json({ error: 'Sign in required' });
        return;
      }
      // Only the document owner can change visibility
      const ownerEmail = getDocumentOwnerEmail(slug);
      if (!ownerEmail || req.session.user.email !== ownerEmail) {
        res.status(403).json({ error: 'Only the document owner can change visibility' });
        return;
      }
      setDocumentVisibility(slug, visibility);
      res.json({ success: true, visibility });
    });

    app.get('/documents/:slug/public-status', (req, res) => {
      const slug = req.params.slug;
      const visibility = getDocumentVisibility(slug);
      const ownerEmail = getDocumentOwnerEmail(slug);
      const isOwner = Boolean(ownerEmail && req.session?.user?.email === ownerEmail);
      const rawShares = getDocumentShares(slug);
      // Only show magic_token to the document owner
      const shares = isOwner
        ? rawShares
        : rawShares.map(({ magic_token, ...rest }) => rest);
      res.json({ isPublic: visibility === 'public', visibility, isOwner, hasOwner: Boolean(ownerEmail), shares });
    });

    // Per-user share management
    app.get('/documents/:slug/shares', (req, res) => {
      const slug = req.params.slug;
      if (!req.session?.user?.email) { res.status(403).json({ error: 'Sign in required' }); return; }
      const ownerEmail = getDocumentOwnerEmail(slug);
      if (!ownerEmail || req.session.user.email !== ownerEmail) {
        res.status(403).json({ error: 'Only the owner can manage shares' }); return;
      }
      res.json({ shares: getDocumentShares(slug) });
    });

    app.post('/documents/:slug/shares', (req, res) => {
      const slug = req.params.slug;
      if (!req.session?.user?.email) { res.status(403).json({ error: 'Sign in required' }); return; }
      const ownerEmail = getDocumentOwnerEmail(slug);
      if (!ownerEmail || req.session.user.email !== ownerEmail) {
        res.status(403).json({ error: 'Only the owner can manage shares' }); return;
      }
      const { email, role } = req.body;
      if (!email || typeof email !== 'string' || !email.includes('@')) {
        res.status(400).json({ error: 'Valid email is required' }); return;
      }
      const validRoles = ['viewer', 'commenter', 'editor'];
      const shareRole = validRoles.includes(role) ? role : 'viewer';
      const cleanEmail = email.trim().toLowerCase();
      const allowedDomain = process.env.GOOGLE_ALLOWED_DOMAIN || 'cultivarium.org';
      const isExternal = !cleanEmail.endsWith('@' + allowedDomain);

      // For external users, generate a magic link token
      let magicToken: string | undefined;
      if (isExternal) {
        // Check if this share already has a token (re-adding with role change)
        const existing = getDocumentShares(slug).find(s => s.email === cleanEmail);
        if (existing?.magic_token) {
          magicToken = existing.magic_token;
        } else {
          const roleMap: Record<string, 'viewer' | 'commenter' | 'editor'> = { viewer: 'viewer', commenter: 'commenter', editor: 'editor' };
          const access = createDocumentAccessToken(slug, roleMap[shareRole] || 'viewer');
          magicToken = access.secret;
        }
      }

      addDocumentShare(slug, cleanEmail, shareRole, req.session.user.email, magicToken);
      // Auto-switch to selective when adding people from private
      const visibility = getDocumentVisibility(slug);
      if (visibility === 'private') {
        setDocumentVisibility(slug, 'selective');
      }
      const newVisibility = getDocumentVisibility(slug);
      res.json({ success: true, shares: getDocumentShares(slug), visibility: newVisibility });
    });

    app.delete('/documents/:slug/shares/:email', (req, res) => {
      const slug = req.params.slug;
      if (!req.session?.user?.email) { res.status(403).json({ error: 'Sign in required' }); return; }
      const ownerEmail = getDocumentOwnerEmail(slug);
      if (!ownerEmail || req.session.user.email !== ownerEmail) {
        res.status(403).json({ error: 'Only the owner can manage shares' }); return;
      }
      const email = decodeURIComponent(req.params.email);
      removeDocumentShare(slug, email);
      res.json({ success: true, shares: getDocumentShares(slug) });
    });

    // Google Workspace directory autocomplete — service account with domain-wide delegation
    let _directoryTokenCache: { token: string; expiry: number } | null = null;
    async function getDirectoryToken(): Promise<string | null> {
      if (_directoryTokenCache && Date.now() < _directoryTokenCache.expiry) {
        return _directoryTokenCache.token;
      }
      // Support both service account key (preferred) and static token (legacy)
      const keyJson = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
      if (keyJson) {
        try {
          const { JWT } = await import('google-auth-library');
          const credentials = JSON.parse(keyJson);
          const subject = process.env.GOOGLE_ADMIN_SUBJECT || '';
          const client = new JWT({
            email: credentials.client_email,
            key: credentials.private_key,
            scopes: ['https://www.googleapis.com/auth/admin.directory.user.readonly'],
            subject,
          });
          const { token } = await client.getAccessToken();
          if (token) {
            _directoryTokenCache = { token, expiry: Date.now() + 55 * 60 * 1000 };
            return token;
          }
        } catch (e) {
          console.error('Failed to get directory token from service account:', e);
        }
      }
      // Legacy fallback: static token from env
      return process.env.GOOGLE_ADMIN_DIRECTORY_TOKEN || null;
    }

    app.get('/api/directory/users', async (req, res) => {
      if (!req.session?.user?.email) { res.status(403).json({ error: 'Sign in required' }); return; }
      const query = typeof req.query.q === 'string' ? req.query.q.trim() : '';
      if (!query || query.length < 2) { res.json({ users: [] }); return; }
      const allowedDomain = process.env.GOOGLE_ALLOWED_DOMAIN || 'cultivarium.org';
      // Try Google Admin SDK Directory API
      const adminToken = await getDirectoryToken();
      if (adminToken) {
        try {
          const url = `https://admin.googleapis.com/admin/directory/v1/users?domain=${encodeURIComponent(allowedDomain)}&query=${encodeURIComponent(query)}&maxResults=10&fields=users(primaryEmail,name)`;
          const gRes = await fetch(url, { headers: { Authorization: `Bearer ${adminToken}` } });
          if (gRes.ok) {
            const data = await gRes.json() as { users?: Array<{ primaryEmail: string; name?: { fullName?: string } }> };
            res.json({
              users: (data.users || []).map((u: { primaryEmail: string; name?: { fullName?: string } }) => ({
                email: u.primaryEmail,
                name: u.name?.fullName || u.primaryEmail.split('@')[0],
              })),
            });
            return;
          }
        } catch (e) { /* fall through to local matching */ }
      }
      // Fallback: match against known users from sessions/document owners
      try {
        const { getKnownDomainUsers } = await import('./google-auth.js');
        const users = getKnownDomainUsers(query, allowedDomain);
        res.json({ users });
      } catch {
        res.json({ users: [] });
      }
    });

    // Claim ownership of a document (via session + optional owner token)
    app.post('/documents/:slug/claim-ownership', (req, res) => {
      const slug = req.params.slug;
      const doc = getDocumentBySlug(slug);
      if (!doc) { res.status(404).json({ error: 'Document not found' }); return; }
      if (!req.session?.user?.email) {
        res.status(403).json({ error: 'Sign in required' });
        return;
      }
      const email = req.session.user.email;
      const existingOwner = getDocumentOwnerEmail(slug);
      // Already owned by this user — idempotent success
      if (existingOwner && existingOwner === email) {
        res.json({ success: true, ownerEmail: email });
        return;
      }
      // Check if user has the owner token (from x-share-token header or query)
      const presentedToken = req.header('x-share-token') || (typeof req.query.token === 'string' ? req.query.token : '');
      const hasOwnerToken = presentedToken && canMutateByOwnerIdentity(doc, presentedToken);
      // Owned by someone else — only allow override with owner token
      if (existingOwner && !hasOwnerToken) {
        res.status(403).json({ error: 'Document already has an owner' });
        return;
      }
      setDocumentOwnerEmail(slug, email);
      res.json({ success: true, ownerEmail: email });
    });

    // Archive toggle
    app.post('/documents/:slug/toggle-archive', (req, res) => {
      const slug = req.params.slug;
      const doc = getDocumentBySlug(slug);
      if (!doc) { res.status(404).json({ error: 'Document not found' }); return; }
      const ownerEmail = getDocumentOwnerEmail(slug);
      if (!req.session?.user?.email || req.session.user.email !== ownerEmail) {
        res.status(403).json({ error: 'Only the document owner can archive/unarchive this document' });
        return;
      }
      const current = isDocumentArchived(slug);
      setDocumentArchived(slug, !current);
      res.json({ success: true, archived: !current });
    });

    // View tracking
    app.post('/documents/:slug/record-view', (req, res) => {
      const slug = req.params.slug;
      let email = req.session?.user?.email || null;
      let name = req.session?.user?.name || null;
      // Resolve identity from magic link token if no session
      if (!email) {
        const shareToken = (req.header('x-share-token') || '').trim();
        if (shareToken) {
          const share = getShareByMagicToken(shareToken);
          if (share) { email = share.email; name = share.email.split('@')[0]; }
        }
      }
      recordDocumentView(slug, email, name);
      res.json({ success: true });
    });

    app.get('/documents/:slug/views', (req, res) => {
      const slug = req.params.slug;
      const viewCount = getDocumentViewCount(slug);
      const recentViewers = getDocumentRecentViewers(slug);
      const history = getDocumentViewHistory(slug);
      res.json({ viewCount, recentViewers, history });
    });

    app.get('/documents/:slug/versions', (req, res) => {
      const slug = req.params.slug;
      const doc = getDocumentBySlug(slug);
      if (!doc) { res.status(404).json({ error: 'Document not found' }); return; }
      res.json(listDocumentVersions(slug));
    });

    app.get('/documents/:slug/versions/:id', (req, res) => {
      const slug = req.params.slug;
      const id = parseInt(req.params.id, 10);
      if (isNaN(id)) { res.status(400).json({ error: 'Invalid version id' }); return; }
      const version = getDocumentVersion(slug, id);
      if (!version) { res.status(404).json({ error: 'Version not found' }); return; }
      res.json(version);
    });

    app.post('/documents/:slug/versions/:id/restore', (req, res) => {
      const slug = req.params.slug;
      const id = parseInt(req.params.id, 10);
      if (isNaN(id)) { res.status(400).json({ error: 'Invalid version id' }); return; }
      const version = getDocumentVersion(slug, id);
      if (!version) { res.status(404).json({ error: 'Version not found' }); return; }
      // Save current state as a version before restoring
      const currentDoc = getDocumentBySlug(slug);
      if (currentDoc?.markdown) {
        try {
          saveDocumentVersion(slug, currentDoc.markdown, currentDoc.title, currentDoc.revision, 'system:pre-restore', currentDoc.marks);
        } catch (e) { /* ignore */ }
      }
      res.json({ success: true, markdown: version.markdown, title: version.title, marks_json: version.marks_json });
    });
  }

  app.use(discoveryRoutes);
  app.use('/api', enforceApiClientCompatibility, apiRoutes);
  app.use('/api/agent', agentRoutes);
  app.use(apiRoutes);
  app.use('/d', createBridgeMountRouter(enforceBridgeClientCompatibility));
  app.use('/documents', createBridgeMountRouter(enforceBridgeClientCompatibility));
  app.use('/documents', agentRoutes);
  app.use(shareWebRoutes);

  setupWebSocket(wss);
  await startCollabRuntimeEmbedded(PORT);

  server.listen(PORT, () => {
    console.log(`[agentdoc] listening on http://127.0.0.1:${PORT}`);

    // Keep-alive: ping /health every 4 minutes to prevent Railway idle shutdown
    setInterval(() => {
      fetch(`http://127.0.0.1:${PORT}/health`).catch(() => {});
    }, 4 * 60 * 1000);
  });
}

main().catch((error) => {
  console.error('[agentdoc] failed to start server', error);
  process.exit(1);
});
