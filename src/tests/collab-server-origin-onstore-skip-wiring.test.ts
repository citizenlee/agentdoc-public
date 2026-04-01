import fs from 'node:fs';
import path from 'node:path';

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

const collabPath = path.resolve(process.cwd(), 'server/collab.ts');
const source = fs.readFileSync(collabPath, 'utf8');
const matches = [...source.matchAll(/async onStoreDocument\(data: \{ documentName: string; document: Y\.Doc; context\?: unknown; transactionOrigin\?: unknown \}\) \{([\s\S]*?)\n      \},/g)];

assert(matches.length === 3, `Expected three onStoreDocument handlers, found ${matches.length}`);
for (const [index, match] of matches.entries()) {
  const body = match[1] ?? '';
  assert(
    body.includes("if (getContextAccessEpoch(data.context) === null) {")
      && body.includes('Server-origin transactions (e.g. projection refresh / canonical apply) persist explicitly.'),
    `Expected onStoreDocument handler #${index + 1} to skip server-origin transactions before stale-write handling`,
  );
}

console.log('✓ onStoreDocument skips server-origin transactions before stale-write handling');
