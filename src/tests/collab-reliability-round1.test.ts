import { readFileSync } from 'node:fs';
import path from 'node:path';

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

function run(): void {
  const editorPath = path.resolve(process.cwd(), 'src', 'editor', 'index.ts');
  const editorSource = readFileSync(editorPath, 'utf8');
  assert(
    editorSource.includes('stabilizeCursorAfterRemoteYjsTransaction'),
    'Expected editor cursor stabilizer to exist',
  );
  assert(
    editorSource.includes("key.startsWith('y-sync')"),
    'Expected cursor stabilizer to skip y-sync meta transactions',
  );

  const collabPath = path.resolve(process.cwd(), 'server', 'collab.ts');
  const collabSource = readFileSync(collabPath, 'utf8');
  assert(
    collabSource.includes('const persistTx = db.transaction'),
    'Expected persistDoc to wrap persistence in a db.transaction',
  );
  assert(
    collabSource.includes('persistTx();'),
    'Expected persistDoc to execute the transaction',
  );
  assert(
    collabSource.includes('replaceDocumentProjection returned 0 rows'),
    'Expected replaceDocumentProjection no-op to throw inside materializeProjection',
  );
  assert(
    collabSource.includes('updateDocument returned 0 rows'),
    'Expected updateDocument no-op to throw inside materializeProjection',
  );
  assert(
    collabSource.includes('schedulePersistDoc(slug, ydoc)'),
    'Expected persistDoc to reschedule on errors',
  );

  console.log('✓ collab reliability round 1 checks');
}

run();
