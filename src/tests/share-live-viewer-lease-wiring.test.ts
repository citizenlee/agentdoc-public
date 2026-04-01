import { readFileSync } from 'node:fs';
import path from 'node:path';

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

const source = readFileSync(
  path.resolve(process.cwd(), 'server/share-web-routes.ts'),
  'utf8',
);

assert(
  source.includes('function isForcedLiveViewerRequest(req: Request): boolean'),
  'Expected share route to detect forced live-viewer requests',
);

assert(
  source.includes("req.query.view === 'string'") || source.includes("const view = typeof req.query.view === 'string'"),
  'Expected share route to inspect the live-view query params',
);

assert(
  source.includes("req.header('x-agentdoc-live-viewer')"),
  'Expected share route to inspect the live-viewer header',
);

assert(
  source.includes('noteRecentCollabSessionLease('),
  'Expected share route to record a recent collab lease for authenticated live viewers',
);

assert(
  source.includes('upsertActiveCollabConnection({'),
  'Expected share route to publish a DB-backed live-viewer lease for barrier detection',
);

console.log('✓ share live-viewer route records recent collab lease fallback');
