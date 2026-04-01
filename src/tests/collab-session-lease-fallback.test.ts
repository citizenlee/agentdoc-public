import {
  getRecentCollabSessionLeaseCount,
  noteRecentCollabSessionLease,
} from '../../server/collab.ts';

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

const slug = `lease-fallback-${Date.now()}`;

assert(getRecentCollabSessionLeaseCount(slug, 7) === 0, 'Expected no recent lease before note');

noteRecentCollabSessionLease(slug, 7, 5_000);
assert(getRecentCollabSessionLeaseCount(slug, 7) === 1, 'Expected recent lease after note');
assert(getRecentCollabSessionLeaseCount(slug, 8) === 0, 'Expected access epoch isolation for recent lease fallback');

console.log('✓ recent collab session lease fallback isolates by access epoch');
