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

async function sleep(ms: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}

async function run(): Promise<void> {
  const dbName = `agentdoc-collab-onstore-quarantine-${Date.now()}-${Math.random().toString(36).slice(2)}.db`;
  const dbPath = path.join(os.tmpdir(), dbName);
  const previousEnv = {
    DATABASE_PATH: process.env.DATABASE_PATH,
    COLLAB_STALE_ONSTORE_DRIFT_COOLDOWN_MS: process.env.COLLAB_STALE_ONSTORE_DRIFT_COOLDOWN_MS,
  };
  process.env.DATABASE_PATH = dbPath;
  process.env.COLLAB_STALE_ONSTORE_DRIFT_COOLDOWN_MS = '50';

  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map((arg) => String(arg)).join(' '));
    originalWarn(...args);
  };

  const markdownA = '# Content A\n\nOriginal.';
  const markdownB = '# Content B\n\nExternal edit.';

  const db = await import('../../server/db.ts');
  const collab = await import('../../server/collab.ts');
  const metrics = await import('../../server/metrics.ts');

  try {
    const slug = `onstore-quarantine-${Math.random().toString(36).slice(2, 10)}`;
    await collab.startCollabRuntimeEmbedded(4000);
    db.createDocument(slug, markdownA, {}, 'onStore drift quarantine test');

    const ydocA = new Y.Doc();
    setMarkdown(ydocA, markdownA);
    const updateA = Y.encodeStateAsUpdate(ydocA);
    const seqA = db.appendYUpdate(slug, updateA, 'seed-a');
    db.saveYSnapshot(slug, seqA, updateA);

    const instance = collab.__unsafeGetHocuspocusInstanceForTests() as any;
    const loadedDoc = await instance.createDocument(
      slug,
      {},
      'test-socket',
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

    await collab.__unsafePersistOnStoreDocumentForTests(slug, loadedDoc);
    await collab.__unsafePersistOnStoreDocumentForTests(slug, loadedDoc);
    await collab.__unsafePersistOnStoreDocumentForTests(slug, loadedDoc);

    const metricsAfterThird = metrics.renderMetricsText();
    const queuedAfterThird = readMetricValue(
      metricsAfterThird,
      'projection_repair_total',
      [['result', 'queued'], ['reason', 'projection_drift_onstore_skip']],
    );
    assert(queuedAfterThird === 2, `Expected queue count=2 after suppression, got ${queuedAfterThird}`);
    const suppressedAfterThird = readMetricValue(
      metricsAfterThird,
      'collab_log_suppressed_total',
      [['kind', 'stale_onstore_drift'], ['reason', 'projection_drift_onstore_skip']],
    );
    assert(suppressedAfterThird === 1, `Expected one suppressed stale onStore log, got ${suppressedAfterThird}`);

    await sleep(80);
    await collab.__unsafePersistOnStoreDocumentForTests(slug, loadedDoc);

    const reloadWarnings = warnings.filter((entry) => entry.includes('[collab_stale_onstore_reload]'));
    assert(reloadWarnings.length === 3, `Expected three stale-onStore reload warnings across fingerprint change + cooldown boundary, got ${reloadWarnings.length}`);

    const metricsAfterFourth = metrics.renderMetricsText();
    const queuedAfterFourth = readMetricValue(
      metricsAfterFourth,
      'projection_repair_total',
      [['result', 'queued'], ['reason', 'projection_drift_onstore_skip']],
    );
    assert(queuedAfterFourth === 2, `Expected queue count to remain 2 after reload-based quarantine handling, got ${queuedAfterFourth}`);

    const row = db.getDocumentBySlug(slug);
    assert((row?.markdown ?? '').includes('Content B'), 'Expected canonical markdown to remain external content');
    assert(!(row?.markdown ?? '').includes('Content A'), 'Expected stale content not to overwrite canonical markdown');

    console.log('✓ stale onStore drift reload logs are quarantined per slug/fingerprint');
  } finally {
    console.warn = originalWarn;
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
