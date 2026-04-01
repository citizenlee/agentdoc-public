import { readFileSync } from 'node:fs';
import path from 'node:path';

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

function run(): void {
  const indexSource = readFileSync(path.resolve(process.cwd(), 'server', 'index.ts'), 'utf8');
  const wsSource = readFileSync(path.resolve(process.cwd(), 'server', 'ws.ts'), 'utf8');
  const dbSource = readFileSync(path.resolve(process.cwd(), 'server', 'db.ts'), 'utf8');
  const routesSource = readFileSync(path.resolve(process.cwd(), 'server', 'routes.ts'), 'utf8');
  const agentRoutesSource = readFileSync(path.resolve(process.cwd(), 'server', 'agent-routes.ts'), 'utf8');
  const bridgeSource = readFileSync(path.resolve(process.cwd(), 'server', 'bridge.ts'), 'utf8');
  const collabSource = readFileSync(path.resolve(process.cwd(), 'server', 'collab.ts'), 'utf8');
  const documentEngineSource = readFileSync(path.resolve(process.cwd(), 'server', 'document-engine.ts'), 'utf8');
  const agentEditV2Source = readFileSync(path.resolve(process.cwd(), 'server', 'agent-edit-v2.ts'), 'utf8');
  const shareClientSource = readFileSync(path.resolve(process.cwd(), 'src/bridge/share-client.ts'), 'utf8');
  const editorSource = readFileSync(path.resolve(process.cwd(), 'src/editor/index.ts'), 'utf8');

  assert(
    wsSource.includes("ws.close(4001, 'Missing authentication token')"),
    'Expected WS handshake to reject missing tokens with close code 4001',
  );
  assert(
    wsSource.includes("ws.close(4003, 'Invalid or expired token')"),
    'Expected WS handshake to reject invalid tokens with close code 4003',
  );
  assert(
    wsSource.includes("const ALLOWED_BROADCAST_TYPES = new Set(['cursor.update', 'selection.update'])"),
    'Expected WS broadcast allowlist for client-originated messages',
  );
  assert(
    wsSource.includes("ws.on('error', (error) => {")
      && wsSource.includes("console.error('[ws] socket error', {")
      && wsSource.includes('mode: isCollabConnection ? \'collab\' : \'bridge\','),
    'Expected setupWebSocket to install per-socket error handling for bridge and collab traffic',
  );
  assert(
    wsSource.includes('if (isCollabConnection) {')
      && wsSource.includes("const collabToken = url.searchParams.get('token') || extractCollabTokenFromHeaders(req.headers);")
      && wsSource.includes("ws.close(4401, 'Invalid or expired collab session token')")
      && wsSource.includes('handleCollabWebSocketConnection(ws, req);')
      && wsSource.includes("try { ws.close(1011, 'Collab runtime failed'); } catch { /* ignore */ }"),
    'Expected collab multiplex path to pre-validate query/header tokens when present and fail closed when collab handling throws',
  );
  assert(
    indexSource.includes("wss.on('error', (error) => {")
      && indexSource.includes("console.error('[server] WebSocketServer error (non-fatal):', error);"),
    'Expected top-level WebSocket server errors to be logged as non-fatal',
  );
  assert(
    routesSource.includes("return { role: 'editor', tokenId: null, ownerAuthorized: false };"),
    'Expected tokenless open-context role to default to editor',
  );
  assert(
    routesSource.includes("let role: ShareRole = requestedRole ?? 'editor';"),
    'Expected tokenless collab-session role to default to editor',
  );
  assert(
    routesSource.includes('applyCanonicalDocumentToCollab(slug'),
    'Expected PUT /documents/:slug to apply canonical updates into collab runtime when enabled',
  );
  assert(
    routesSource.includes('invalidateCollabDocument(slug);'),
    'Expected PUT /documents/:slug to retain an invalidate fallback when collab apply fails or is disabled',
  );
  assert(
    routesSource.includes("if (op === 'rewrite.apply') {")
      && routesSource.includes('await prepareRewriteCollabBarrier(slug);'),
    'Expected /documents/:slug/ops rewrite.apply to enforce a collab rewrite barrier',
  );
  assert(
    routesSource.includes('Route-level reapplication from the DB can replay stale markdown')
      && !routesSource.includes("source: 'rest-ops'"),
    'Expected /documents/:slug/ops to avoid broad DB reapply after engine-backed mutations',
  );
  assert(
    agentRoutesSource.includes("if (op === 'rewrite.apply') {")
      && agentRoutesSource.includes('await prepareRewriteCollabBarrier(slug);')
      && agentRoutesSource.includes("agentRoutes.post('/:slug/rewrite', async"),
    'Expected agent rewrite routes to enforce a collab rewrite barrier',
  );
  assert(
    agentRoutesSource.includes('Promise.race')
      && agentRoutesSource.includes('REWRITE_BARRIER_TIMEOUT_MS')
      && agentRoutesSource.includes('invalidateCollabDocumentAndWait'),
    'Expected rewrite barrier to use a configurable timeout for invalidateCollabDocumentAndWait',
  );
  const editV2RouteSource = (() => {
    const match = agentRoutesSource.match(
      /agentRoutes\.post\('\/:slug\/edit\/v2', async[\s\S]*?\n\}\);\n\n\/\/ Apply targeted edit operations/,
    );
    return match?.[0] ?? '';
  })();
  assert(
    !agentRoutesSource.includes('shouldPrepareEditV2CollabBarrier')
      && !agentRoutesSource.includes('isLikelyValidEditV2PayloadForBarrier')
      && !editV2RouteSource.includes('prepareRewriteCollabBarrier(slug);'),
    'Expected /agent/:slug/edit/v2 to avoid rewrite-style collab barrier churn',
  );
  assert(
    /apiRoutes\.put\('\/documents\/:slug', async[\s\S]*?if \(hasMarkdownUpdate\) \{[\s\S]*?await prepareRewriteCollabBarrier\(slug\);/.test(routesSource),
    'Expected PUT /documents/:slug markdown updates to enforce a collab rewrite barrier',
  );
  assert(
    bridgeSource.includes("if (method === 'POST' && bridgePath === '/rewrite') {")
      && bridgeSource.includes('await prepareRewriteCollabBarrier(slug);'),
    'Expected bridge /rewrite to enforce a collab rewrite barrier',
  );
  assert(
    !bridgeSource.includes('await applyCanonicalDocumentToCollab(slug, applyOptions);')
      && !bridgeSource.includes('const applyOptions = {'),
    'Expected server-executed bridge mutations to avoid broad DB reapply into live collab rooms',
  );
  assert(
    /applyCanonicalDocumentToCollab\(slug[\s\S]*?\.catch\(\(error\)\s*=>\s*\{[\s\S]*?invalidateCollabDocument\(slug\);/.test(documentEngineSource),
    'Expected document-engine mark sync failures to invalidate collab projection as fallback',
  );
  assert(
    /const result(?:: EngineExecutionResult)? = op === 'rewrite\.apply'[\s\S]*?\? await executeCanonicalRewrite\(slug, opRoute\.body\)(?: as EngineExecutionResult)?/.test(routesSource),
    'Expected /documents/:slug/ops rewrite.apply to execute through canonical rewrite path',
  );
  assert(
    /const result = op === 'rewrite\.apply'[\s\S]*?\? await executeCanonicalRewrite\(slug, opRoute\.body\)/.test(agentRoutesSource)
      && /agentRoutes\.post\('\/:slug\/rewrite', async[\s\S]*?const result = await executeCanonicalRewrite\(slug, asPayload\(req\.body\)\);/.test(agentRoutesSource),
    'Expected agent rewrite flows to execute through canonical rewrite path',
  );
  assert(
    /agentRoutes\.post\('\/:slug\/edit', async[\s\S]*?notifyCollabMutation\([\s\S]*?\{\s*verify:\s*true,\s*source:\s*by[\s\S]*stabilityMs:\s*EDIT_COLLAB_STABILITY_MS[\s\S]*fallbackBarrier:\s*true[\s\S]*apply:\s*false[\s\S]*\}/.test(agentRoutesSource),
    'Expected /agent/:slug/edit to verify collab propagation without replaying DB state',
  );
  assert(
    agentRoutesSource.includes('{ verify: false, apply: false }')
      && agentRoutesSource.includes("{ apply: false }"),
    'Expected non-rewrite agent mutation routes to update presence/verification without broad DB reapply',
  );
  assert(
    agentRoutesSource.includes('verifyCanonicalDocumentStable(')
      && agentRoutesSource.includes("reason = canonical.reason ?? 'canonical_stability_regressed';")
      && agentRoutesSource.includes("source: `${options.source ?? 'agent'}-fallback`,"),
    'Expected /agent/:slug/edit to verify canonical durability and reapply the intended document on fallback',
  );
  assert(
    agentEditV2Source.includes('strictLiveDoc: true')
      && (
        agentEditV2Source.includes("status: 'confirmed'")
        || agentEditV2Source.includes("status: collabResult.confirmed ? 'confirmed' : 'pending'")
      )
      && agentEditV2Source.includes('const snapshot = await buildSnapshot(slug);'),
    'Expected /agent/:slug/edit/v2 to require strict live canonical mutation and return confirmed collab state',
  );
  assert(
    agentRoutesSource.includes("status: collabApplied ? 'confirmed' : 'pending'")
      && agentRoutesSource.includes('canonicalStatus'),
    'Expected /agent/:slug/edit response to expose pending propagation and canonical durability status',
  );
  assert(
    /const serverResult = method === 'POST' && bridgePath === '\/rewrite'[\s\S]*?\? await executeCanonicalRewrite\(slug, requestBody\)/.test(bridgeSource),
    'Expected bridge /rewrite server path to execute through canonical rewrite path',
  );
  assert(
    collabSource.includes('export async function invalidateCollabDocumentAndWait(slug: string): Promise<void>'),
    'Expected collab runtime to expose an awaitable invalidate helper',
  );
  assert(
    collabSource.includes("const shareToken = readHeaderValue(headers, 'x-share-token').trim();")
      && collabSource.includes('export function extractCollabTokenFromHeaders(headers: unknown): string {')
      && collabSource.includes("if (shareToken) return shareToken;"),
    'Expected collab token extraction to support x-share-token headers',
  );
  assert(
    collabSource.includes('function attachCollabSocketErrorHandler(socket: unknown, request: unknown, source: string): void')
      && collabSource.includes("wsLike.on('error', (error) => {")
      && collabSource.includes("console.error('[collab] websocket connection error', {"),
    'Expected collab runtime to define a per-connection socket error handler',
  );
  assert(
    collabSource.includes("attachCollabSocketErrorHandler(socket, request, 'ws-router');")
      && collabSource.includes("attachCollabSocketErrorHandler(socket, request, 'attached-runtime');"),
    'Expected both collab WS entrypoints to attach per-socket error handlers',
  );
  assert(
    dbSource.includes('export function getDocumentAuthStateBySlug(slug: string): DocumentAuthStateRow | undefined')
      && dbSource.includes('SELECT slug, doc_id, share_state, access_epoch, owner_secret, owner_secret_hash')
      && dbSource.includes('const doc = getDocumentAuthStateBySlug(slug);'),
    'Expected access resolution to use lightweight document auth-state reads',
  );
  assert(
    collabSource.includes('const doc = getDocumentAuthStateBySlug(documentName);')
      && collabSource.includes('const doc = getDocumentAuthStateBySlug(slug);')
      && collabSource.includes('const doc = getDocumentAuthStateBySlug(data.documentName);'),
    'Expected collab auth/session paths to use lightweight auth-state lookups',
  );
  assert(
    collabSource.includes("|| (claims.role === 'editor' && doc.share_state === 'ACTIVE')"),
    'Expected editor active share write permission in collab runtime',
  );
  assert(
    !collabSource.includes("|| (claims.role === 'commenter' && doc.share_state === 'ACTIVE')"),
    'Expected commenter transport-level write access to be removed',
  );
  const authReadOnlyAssignments = collabSource.match(/data\.connection\.readOnly\s*=\s*!auth\.canWrite/g)?.length ?? 0;
  assert(
    authReadOnlyAssignments >= 2,
    'Expected onAuthenticate hooks to enforce readOnly from canWrite in collab runtimes',
  );
  assert(
    collabSource.includes('accessEpoch: number;')
      && collabSource.includes('accessEpoch: doc.access_epoch,')
      && shareClientSource.includes('accessEpoch: number;')
      && shareClientSource.includes('typeof candidate.accessEpoch === \'number\'')
      && shareClientSource.includes('Number.isFinite(candidate.accessEpoch)'),
    'Expected collab session contracts to require a numeric accessEpoch on both server and client',
  );
  assert(
    collabSource.includes("syncProtocol: 'pm-yjs-v1';"),
    'Expected collab session contract to include syncProtocol in server type',
  );
  assert(
    collabSource.includes("syncProtocol: 'pm-yjs-v1',"),
    'Expected collab session payload to include syncProtocol',
  );
  assert(
    shareClientSource.includes("syncProtocol: 'pm-yjs-v1';"),
    'Expected client-side collab session contract to require syncProtocol',
  );
  assert(
    shareClientSource.includes("candidate.syncProtocol === 'pm-yjs-v1'"),
    'Expected client-side session parser to enforce syncProtocol compatibility',
  );
  assert(
    editorSource.includes('pendingCollabRebindOnSync')
      && editorSource.includes('if (this.pendingCollabRebindOnSync)')
      && (
        editorSource.includes('this.connectCollabService();')
        || editorSource.includes('this.connectCollabService(shouldResetDoc);')
      ),
    'Expected editor reconnect path to defer collab rebind until synced',
  );
  assert(
    editorSource.includes('const latest = await shareClient.fetchDocument();')
      && editorSource.includes('this.resetProjectionPublishState();')
      && !editorSource.includes('collabClient.setProjectionMarkdown(reconnectTemplate);'),
    'Expected editor reconnect path to avoid direct projection markdown writes before hydration completes',
  );

  console.log('✓ collab security guardrails');
}

try {
  run();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
