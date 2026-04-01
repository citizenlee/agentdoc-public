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

function setMarks(doc: Y.Doc, marks: Record<string, unknown>): void {
  const map = doc.getMap<unknown>('marks');
  const nextKeys = new Set(Object.keys(marks));
  map.forEach((_value, key) => {
    if (!nextKeys.has(key)) map.delete(key);
  });
  for (const [key, value] of Object.entries(marks)) {
    map.set(key, value);
  }
}

async function run(): Promise<void> {
  const dbName = `agentdoc-collab-preserve-comments-${Date.now()}-${Math.random().toString(36).slice(2)}.db`;
  const dbPath = path.join(os.tmpdir(), dbName);
  process.env.DATABASE_PATH = dbPath;

  const db = await import('../../server/db.ts');
  const collab = await import('../../server/collab.ts');

  const slug = `preserve-comments-${Math.random().toString(36).slice(2, 10)}`;
  const markdown = '# Comment preserve\n\nShared Belief: Claws';
  const commentId = `comment-${Math.random().toString(36).slice(2, 10)}`;
  const authoredId = `authored-${Math.random().toString(36).slice(2, 10)}`;

  const initialMarks: Record<string, unknown> = {
    [commentId]: {
      kind: 'comment',
      by: 'ai:test',
      createdAt: new Date().toISOString(),
      quote: 'Shared Belief: Claws',
      text: 'keep me',
      threadId: commentId,
      thread: [],
      resolved: false,
    },
    [authoredId]: {
      kind: 'authored',
      by: 'human:test',
      createdAt: '1970-01-01T00:00:00.000Z',
      quote: 'Shared Belief: Claws',
      range: { from: 1, to: 20 },
    },
  };

  await collab.startCollabRuntimeEmbedded(4000);
  try {
    db.createDocument(slug, markdown, initialMarks, 'projection preservation test');

    const ydocSeed = new Y.Doc();
    setMarkdown(ydocSeed, markdown);
    setMarks(ydocSeed, initialMarks);
    const seedUpdate = Y.encodeStateAsUpdate(ydocSeed);
    const seq = db.appendYUpdate(slug, seedUpdate, 'test-seed');
    db.saveYSnapshot(slug, seq, seedUpdate);

    const instance = collab.__unsafeGetHocuspocusInstanceForTests() as any;
    assert(instance && typeof instance.createDocument === 'function', 'Expected collab runtime test instance');
    const loadedDoc = await instance.createDocument(
      slug,
      {},
      'test-socket',
      { isAuthenticated: true, readOnly: false, requiresAuthentication: true },
      {},
    );

    // Simulate a stale/old client publishing authored-only marks metadata.
    loadedDoc.transact(() => {
      const map = loadedDoc.getMap<unknown>('marks');
      map.forEach((_value, key) => map.delete(key));
      map.set(authoredId, initialMarks[authoredId]);
      const text = loadedDoc.getText('markdown');
      text.insert(text.length, '\n');
    }, 'test-authored-only');

    await collab.stopCollabRuntime();

    const after = db.getDocumentBySlug(slug);
    assert(Boolean(after), 'Expected document row to exist');
    const parsedMarks = (() => {
      try {
        return JSON.parse(after?.marks ?? '{}') as Record<string, unknown>;
      } catch {
        return {};
      }
    })();

    const preservedComment = parsedMarks[commentId] as { kind?: string } | undefined;
    assert(Boolean(preservedComment), 'Expected comment mark to remain after authored-only projection write');
    assert(
      preservedComment?.kind === 'comment',
      `Expected preserved mark kind=comment, got ${String(preservedComment?.kind)}`,
    );

    console.log('✓ collab projection preserves non-authored marks when incoming metadata is incomplete');
  } finally {
    await collab.stopCollabRuntime();
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

