import { readFileSync } from 'node:fs';
import path from 'node:path';

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

const source = readFileSync(
  path.resolve(process.cwd(), 'server/collab.ts'),
  'utf8',
);

assert(
  source.includes('function attachAuthenticatedCollabPresence('),
  'Expected collab runtime to attach authenticated presence inside collab auth flow',
);

assert(
  source.includes('upsertActiveCollabConnection({'),
  'Expected collab runtime to upsert authenticated collab presence from Hocuspocus hooks',
);

assert(
  source.includes('async onDisconnect(data: { context?: unknown })'),
  'Expected collab runtime to remove authenticated presence on disconnect',
);

assert(
  source.includes('detachAuthenticatedCollabPresence(data.context);'),
  'Expected collab runtime disconnect hook to clear authenticated collab presence',
);

console.log('✓ collab authenticated presence is managed by auth/disconnect hooks');
