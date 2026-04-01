import { unlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { yXmlFragmentToProseMirrorRootNode } from 'y-prosemirror';

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

async function run(): Promise<void> {
  const dbName = `agentdoc-collab-legacy-seed-${Date.now()}-${Math.random().toString(36).slice(2)}.db`;
  const dbPath = path.join(os.tmpdir(), dbName);
  const previousDbPath = process.env.DATABASE_PATH;
  process.env.DATABASE_PATH = dbPath;

  const db = await import('../../server/db.ts');
  const collab = await import('../../server/collab.ts');
  const { getHeadlessMilkdownParser, serializeMarkdown } = await import('../../server/milkdown-headless.ts');

  const slug = `legacy-seed-${Math.random().toString(36).slice(2, 10)}`;
  const markdown = [
    '# Daily Plan',
    '',
    '## Wednesday, Feb 25, 2026',
    '',
    '**12:00 PM** - Present at Thumbtack offsite',
    '',
    '* [x] Fix markdown rendering of checkboxes and links',
    '',
    '* [ ] Process Lucas\'s stakeholder synthesis dashboard',
    '',
  ].join('\n');

  try {
    db.createDocument(slug, markdown, {}, 'legacy seed markdown roundtrip');

    const before = db.getDocumentBySlug(slug);
    assert(Boolean(before), 'Expected created document row');
    assert((before?.y_state_version ?? 0) === 0, `Expected new document to start without Yjs snapshot, got ${String(before?.y_state_version)}`);
    assert(db.getLatestYSnapshot(slug) == null, 'Expected no Yjs snapshot before legacy seed load');

    const handle = await collab.loadCanonicalYDoc(slug);
    assert(Boolean(handle), 'Expected canonical Yjs handle');

    const parser = await getHeadlessMilkdownParser();
    const root = yXmlFragmentToProseMirrorRootNode(
      handle!.ydoc.getXmlFragment('prosemirror') as any,
      parser.schema as any,
    );
    const serialized = await serializeMarkdown(root as any);

    assert(
      serialized === markdown,
      `Expected parsed legacy seed fragment to roundtrip original markdown.\nExpected:\n${markdown}\n\nActual:\n${serialized}`,
    );

    const after = db.getDocumentBySlug(slug);
    assert(Boolean(after), 'Expected document row after canonical load');
    assert((after?.y_state_version ?? 0) === 1, `Expected canonical load to persist Yjs baseline, got ${String(after?.y_state_version)}`);
    assert(db.getLatestYSnapshot(slug) != null, 'Expected Yjs snapshot after canonical load');
    assert(
      (after?.markdown ?? '') === markdown,
      `Expected canonical markdown to remain unchanged after legacy seed load.\nExpected:\n${markdown}\n\nActual:\n${String(after?.markdown ?? '')}`,
    );

    console.log('✓ legacy markdown seeding preserves canonical markdown and parsed fragment structure');
  } finally {
    if (previousDbPath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDbPath;
    }
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

run().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exit(1);
});
