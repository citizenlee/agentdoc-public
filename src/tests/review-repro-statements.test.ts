import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

const reviewPath = resolve(process.cwd(), 'REVIEW.md');
const review = readFileSync(reviewPath, 'utf8');

const requiredSnippets = [
  '### Repro (tight)',
  'With a document that has an `owner_secret_hash`',
  'Run `backfillDocumentColumns()` on a legacy row with `owner_secret` set',
  'Open the same doc in two clients and type a single character',
];

for (const snippet of requiredSnippets) {
  assert(review.includes(snippet), `Missing repro statement snippet: ${snippet}`);
}

console.log('✓ repro statements present for first three findings');
