import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import express from 'express';
import { WebSocket, WebSocketServer, type RawData } from 'ws';
import { createDocument } from '../../server/db';

type WsMessage = Record<string, unknown>;

function parseMessage(data: RawData): WsMessage {
  return JSON.parse(data.toString()) as WsMessage;
}

async function connectViewer(
  wsBase: string,
  slug: string,
  token: string,
  options: {
    bridgeCapable: boolean;
    onBridgeRequest?: (message: WsMessage, ws: WebSocket) => void;
  }
): Promise<WebSocket> {
  const ws = new WebSocket(`${wsBase}/ws?slug=${slug}&token=${encodeURIComponent(token)}`);

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out opening WebSocket for ${slug}`)), 2500);
    ws.once('open', () => {
      clearTimeout(timer);
      resolve();
    });
    ws.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });

  ws.on('message', (data: RawData) => {
    const message = parseMessage(data);
    if (message.type === 'bridge.request') {
      options.onBridgeRequest?.(message, ws);
    }
  });

  ws.send(JSON.stringify({
    type: 'viewer.identify',
    name: `test-${slug}`,
    capabilities: { bridge: options.bridgeCapable },
  }));

  await new Promise<void>((resolve) => setTimeout(resolve, 60));
  return ws;
}

async function run(): Promise<void> {
  process.env.DATABASE_PATH = path.join(tmpdir(), `agentdoc-bridge-ws-${randomUUID()}.db`);
  process.env.BRIDGE_REQUEST_TIMEOUT_MS = '120';
  process.env.BRIDGE_RATE_LIMIT_MAX_UNAUTH_PER_MIN = '200';
  process.env.BRIDGE_RATE_LIMIT_MAX_AUTH_PER_MIN = '200';

  const [{ bridgeRouter }, { setupWebSocket }] = await Promise.all([
    import('../../server/bridge'),
    import('../../server/ws'),
  ]);

  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use('/d/:slug/bridge', bridgeRouter);

  const server = createServer(app);
  const wss = new WebSocketServer({ server, path: '/ws' });
  setupWebSocket(wss);

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Failed to start test server');
  }

  const httpBase = `http://127.0.0.1:${address.port}`;
  const wsBase = `ws://127.0.0.1:${address.port}`;

  const sockets: WebSocket[] = [];

  try {
    const noBridgeOwnerSecret = 'bridge-owner-secret-nobridge';
    createDocument('nobridge', '# nobridge', {}, 'No bridge', 'owner-1', noBridgeOwnerSecret);
    const noBridgeViewer = await connectViewer(wsBase, 'nobridge', noBridgeOwnerSecret, { bridgeCapable: false });
    sockets.push(noBridgeViewer);

    const noBridgeRes = await fetch(`${httpBase}/d/nobridge/bridge/presence`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-bridge-token': noBridgeOwnerSecret,
      },
      body: JSON.stringify({ status: 'ping' }),
    });
    const noBridgeBody = await noBridgeRes.json() as {
      code?: string;
      hint?: string;
      nextSteps?: string[];
    };
    assert.equal(noBridgeRes.status, 503, 'No-bridge-capable viewer should return 503');
    assert.equal(noBridgeBody.code, 'NO_BRIDGE_CAPABLE_VIEWER', 'Expected NO_BRIDGE_CAPABLE_VIEWER code');
    assert.match(String(noBridgeBody.hint), /bridge messaging is not ready|Refresh/i,
      'No-bridge-capable hint should instruct refresh/reconnect');
    assert((noBridgeBody.nextSteps ?? []).length >= 2, 'No-bridge-capable response should include next steps');

    const timeoutOwnerSecret = 'bridge-owner-secret-timeout';
    createDocument('timeoutslug', '# timeout', {}, 'Timeout', 'owner-1', timeoutOwnerSecret);
    const timeoutViewer = await connectViewer(wsBase, 'timeoutslug', timeoutOwnerSecret, { bridgeCapable: true });
    sockets.push(timeoutViewer);

    const timeoutRes = await fetch(`${httpBase}/d/timeoutslug/bridge/presence`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-bridge-token': timeoutOwnerSecret,
      },
      body: JSON.stringify({ status: 'ping' }),
    });
    const timeoutBody = await timeoutRes.json() as {
      code?: string;
      timeoutMs?: number;
      hint?: string;
      retryable?: boolean;
    };
    assert.equal(timeoutRes.status, 504, 'Non-responsive viewer should timeout with 504');
    assert.equal(timeoutBody.code, 'TIMEOUT', 'Timeout should include TIMEOUT code');
    assert.equal(timeoutBody.retryable, true, 'Timeout should indicate retryability');
    assert.equal(typeof timeoutBody.timeoutMs, 'number', 'Timeout should include timeoutMs');
    assert.match(String(timeoutBody.hint), /did not complete|within/i, 'Timeout hint should explain what happened');

    let fallbackFreshCalls = 0;
    let fallbackStaleCalls = 0;

    const fallbackOwnerSecret = 'bridge-owner-secret-fallback';
    createDocument('fallbackslug', '# fallback', {}, 'Fallback', 'owner-1', fallbackOwnerSecret);

    const fallbackFreshViewer = await connectViewer(wsBase, 'fallbackslug', fallbackOwnerSecret, {
      bridgeCapable: true,
      onBridgeRequest: (message, ws) => {
        fallbackFreshCalls += 1;
        ws.send(JSON.stringify({
          type: 'bridge.response',
          requestId: message.requestId,
          ok: true,
          result: { success: true, source: 'fresh-viewer' },
        }));
      },
    });
    sockets.push(fallbackFreshViewer);

    const fallbackStaleViewer = await connectViewer(wsBase, 'fallbackslug', fallbackOwnerSecret, {
      bridgeCapable: true,
      onBridgeRequest: (message, ws) => {
        fallbackStaleCalls += 1;
        ws.send(JSON.stringify({
          type: 'bridge.response',
          requestId: message.requestId,
          ok: false,
          error: {
            code: 'EXECUTION_ERROR',
            message: 'Cannot read properties of undefined (reading \'editor\')',
            status: 500,
          },
        }));
      },
    });
    sockets.push(fallbackStaleViewer);

    const fallbackRes = await fetch(`${httpBase}/d/fallbackslug/bridge/presence`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-bridge-token': fallbackOwnerSecret,
      },
      body: JSON.stringify({ status: 'ping' }),
    });
    const fallbackBody = await fallbackRes.json() as { success?: boolean; source?: string };
    assert.equal(fallbackRes.status, 200, 'Bridge should retry a different viewer after retryable execution failure');
    assert.equal(fallbackBody.success, true, 'Fallback viewer should complete request successfully');
    assert.equal(fallbackBody.source, 'fresh-viewer', 'Fallback response should come from a healthy viewer');
    assert.equal(fallbackStaleCalls >= 1, true, 'Stale viewer should have been attempted first');
    assert.equal(fallbackFreshCalls >= 1, true, 'Healthy viewer should be attempted after stale viewer fails');

    const passthroughOwnerSecret = 'bridge-owner-secret-passthrough';
    createDocument('passthrough', '# passthrough', {}, 'Passthrough', 'owner-1', passthroughOwnerSecret);
    const passthroughViewer = await connectViewer(wsBase, 'passthrough', passthroughOwnerSecret, {
      bridgeCapable: true,
      onBridgeRequest: (message, ws) => {
        ws.send(JSON.stringify({
          type: 'bridge.response',
          requestId: message.requestId,
          ok: false,
          error: {
            code: 'lossy_rewrite_blocked',
            message: 'Refusing lossy rewrite',
            status: 422,
            hint: 'Use /state.content as rewrite input.',
            nextSteps: ['Fetch /state first', 'Retry /rewrite with markdown content'],
          },
        }));
      },
    });
    sockets.push(passthroughViewer);

    const passthroughRes = await fetch(`${httpBase}/d/passthrough/bridge/presence`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-bridge-token': passthroughOwnerSecret,
      },
      body: JSON.stringify({ status: 'ping' }),
    });
    const passthroughBody = await passthroughRes.json() as {
      code?: string;
      hint?: string;
      nextSteps?: string[];
    };
    assert.equal(passthroughRes.status, 422, 'Bridge should preserve browser-provided 4xx statuses');
    assert.equal(passthroughBody.code, 'lossy_rewrite_blocked', 'Bridge should preserve browser-provided error codes');
    assert.match(String(passthroughBody.hint), /state\.content|rewrite input/i,
      'Bridge should preserve browser-provided hint text');
    assert((passthroughBody.nextSteps ?? []).length >= 2,
      'Bridge should preserve browser-provided next steps');

    console.log('bridge-ws-hints.test.ts passed');
  } finally {
    for (const ws of sockets) {
      try {
        ws.close();
      } catch {
        // ignore
      }
    }

    await new Promise<void>((resolve) => wss.close(() => resolve()));
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
