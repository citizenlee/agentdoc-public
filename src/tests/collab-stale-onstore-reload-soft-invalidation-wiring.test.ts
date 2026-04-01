import fs from 'node:fs';
import path from 'node:path';

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

const collabPath = path.resolve(process.cwd(), 'server/collab.ts');
const source = fs.readFileSync(collabPath, 'utf8');
const fnStart = source.indexOf('function scheduleStaleOnStoreReload(slug: string): void {');
assert(fnStart >= 0, 'Expected scheduleStaleOnStoreReload to exist');
const fnSlice = source.slice(fnStart, fnStart + 300);

assert(
  fnSlice.includes('invalidateLoadedCollabDocumentAndWait(slug)'),
  'Expected stale onStore reload to preserve persisted Yjs state via soft invalidation',
);
assert(
  !fnSlice.includes('invalidateCollabDocumentAndWait(slug)'),
  'Expected stale onStore reload to avoid hard invalidation that clears persisted Yjs state',
);

console.log('✓ stale onStore reload uses soft invalidation');
