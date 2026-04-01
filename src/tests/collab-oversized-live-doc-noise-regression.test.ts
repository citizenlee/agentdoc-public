import { unlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as Y from 'yjs';

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

function setMarkdown(doc: Y.Doc, value: string): void {
  const text = doc.getText('markdown');
  const current = text.toString();
  if (current.length > 0) text.delete(0, current.length);
  if (value.length > 0) text.insert(0, value);
}

function readMetricValue(metricsText: string, metricName: string, filters: Array<[string, string]>): number {
  const lines = metricsText
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'));
  const line = lines.find((entry) => (
    entry.startsWith(`${metricName}{`)
    && filters.every(([key, value]) => entry.includes(`${key}="${value}"`))
  ));
  if (!line) return 0;
  const value = Number.parseFloat(line.slice(line.lastIndexOf(' ') + 1));
  return Number.isFinite(value) ? value : 0;
}

async function run(): Promise<void> {
  const dbName = `agentdoc-collab-live-noise-${Date.now()}-${Math.random().toString(36).slice(2)}.db`;
  const dbPath = path.join(os.tmpdir(), dbName);
  const previousEnv = {
    DATABASE_PATH: process.env.DATABASE_PATH,
    COLLAB_STALE_ONSTORE_DRIFT_COOLDOWN_MS: process.env.COLLAB_STALE_ONSTORE_DRIFT_COOLDOWN_MS,
    COLLAB_WS_OVERSIZE_LOG_COOLDOWN_MS: process.env.COLLAB_WS_OVERSIZE_LOG_COOLDOWN_MS,
  };
  process.env.DATABASE_PATH = dbPath;
  process.env.COLLAB_STALE_ONSTORE_DRIFT_COOLDOWN_MS = '1000';
  process.env.COLLAB_WS_OVERSIZE_LOG_COOLDOWN_MS = '1000';

  const warnings: string[] = [];
  const errors: string[] = [];
  const originalWarn = console.warn;
  const originalError = console.error;
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map((arg) => String(arg)).join(' '));
    originalWarn(...args);
  };
  console.error = (...args: unknown[]) => {
    errors.push(args.map((arg) => String(arg)).join(' '));
    originalError(...args);
  };

  const markdownA = '# Content A\n\nOriginal.';
  const markdownB = '# Content B\n\nExternal edit.';

  const db = await import('../../server/db.ts');
  const collab = await import('../../server/collab.ts');
  const metrics = await import('../../server/metrics.ts');

  try {
    const slug = `oversized-live-noise-${Math.random().toString(36).slice(2, 10)}`;
    await collab.startCollabRuntimeEmbedded(4000);
    db.createDocument(slug, markdownA, {}, 'oversized live noise regression');

    const ydocA = new Y.Doc();
    setMarkdown(ydocA, markdownA);
    const updateA = Y.encodeStateAsUpdate(ydocA);
    const seqA = db.appendYUpdate(slug, updateA, 'seed-a');
    db.saveYSnapshot(slug, seqA, updateA);

    const instance = collab.__unsafeGetHocuspocusInstanceForTests() as any;
    const loadedDoc = await instance.createDocument(
      slug,
      {},
      'noise-socket',
      { isAuthenticated: true, readOnly: false, requiresAuthentication: true },
      {},
    );

    const ydocExternal = new Y.Doc();
    Y.applyUpdate(ydocExternal, updateA);
    setMarkdown(ydocExternal, markdownB);
    const externalDelta = Y.encodeStateAsUpdate(ydocExternal, Y.encodeStateVector(ydocA));
    db.appendYUpdate(slug, externalDelta, 'external-edit');
    const replaced = db.replaceDocumentProjection(slug, markdownB, {}, db.getLatestYStateVersion(slug));
    assert(replaced, 'Expected external projection write to persist');

    for (let i = 0; i < 5; i += 1) {
      await collab.__unsafePersistOnStoreDocumentForTests(slug, loadedDoc);
    }

    const statusSymbol = Symbol('status-code');
    const oversizedError = Object.assign(new Error('Max payload size exceeded'), {
      code: 'WS_ERR_UNSUPPORTED_MESSAGE_LENGTH',
      [statusSymbol]: 1009,
    });
    for (let i = 0; i < 5; i += 1) {
      collab.__unsafeLogCollabSocketErrorForTests({
        url: `/ws?slug=${slug}`,
        headers: {
          'sec-websocket-key': 'oversized-live-session',
          'user-agent': 'codex-live-noise',
          'x-share-token': 'token-present',
        },
        socket: {
          remoteAddress: '127.0.0.1',
        },
      }, 'ws-router', oversizedError);
    }

    const metricsText = metrics.renderMetricsText();
    const queuedDrift = readMetricValue(
      metricsText,
      'projection_repair_total',
      [['result', 'queued'], ['reason', 'projection_drift_onstore_skip']],
    );
    assert(queuedDrift === 2, `Expected only two queued drift repairs for one pathological slug, got ${queuedDrift}`);
    const suppressedDrift = readMetricValue(
      metricsText,
      'collab_log_suppressed_total',
      [['kind', 'stale_onstore_drift'], ['reason', 'projection_drift_onstore_skip']],
    );
    assert(suppressedDrift === 3, `Expected three suppressed stale onStore drift logs, got ${suppressedDrift}`);
    const suppressedWs = readMetricValue(
      metricsText,
      'collab_log_suppressed_total',
      [['kind', 'ws_oversize'], ['reason', 'unsupported_message_length']],
    );
    assert(suppressedWs === 4, `Expected four suppressed websocket oversize logs, got ${suppressedWs}`);

    const mergeSkipWarnings = warnings.filter((entry) => entry.includes('Stale onStoreDocument merge skipped due projection drift'));
    const wsErrorLogs = errors.filter((entry) => entry.includes('[collab] websocket connection error'));
    assert(mergeSkipWarnings.length === 2, `Expected two merge skip warnings before suppression stabilizes, got ${mergeSkipWarnings.length}`);
    assert(wsErrorLogs.length === 1, `Expected one collab websocket error log during suppression window, got ${wsErrorLogs.length}`);

    const row = db.getDocumentBySlug(slug);
    assert((row?.markdown ?? '').includes('Content B'), 'Expected canonical markdown to remain correct');

    console.log('✓ oversized live pathological docs do not generate unbounded sync noise');
  } finally {
    console.warn = originalWarn;
    console.error = originalError;
    await collab.stopCollabRuntime();
    Object.entries(previousEnv).forEach(([key, value]) => {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    });
    for (const suffix of ['', '-wal', '-shm']) {
      try {
        unlinkSync(`${dbPath}${suffix}`);
      } catch {
        // ignore cleanup errors
      }
    }
  }
}

run().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exit(1);
});
