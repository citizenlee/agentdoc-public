import { readFileSync } from 'node:fs';

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

function run(): void {
  const doc = readFileSync('docs/qa/complex-doc-projection-soak.md', 'utf8');
  assert(doc.includes('complex-doc projection soak failed'), 'Expected doc to name the signal string');
  assert(doc.includes('scripts/staging-collab-projection-soak.ts'), 'Expected doc to reference the harness script');
  assert(doc.includes('buildMixedHtmlFixture'), 'Expected doc to mention the soak fixture generator');
  assert(doc.includes('`/edit` then `/edit/v2`'), 'Expected doc to note /edit and /edit/v2 usage');
  assert(doc.includes('rewrite-apply'), 'Expected doc to mention rewrite-apply usage');
  assert(doc.includes('/api/agent/:slug/state'), 'Expected doc to cite canonical state source');
  assert(doc.includes('SOAK_LIVE_VIEWERS'), 'Expected doc to mention SOAK_LIVE_VIEWERS');
  assert(doc.includes('SOAK_MUTATION_MODE'), 'Expected doc to mention SOAK_MUTATION_MODE');
  assert(doc.includes('SOAK_DOC_COMPLEXITY'), 'Expected doc to mention SOAK_DOC_COMPLEXITY');
  assert(doc.includes('SOAK_REPEAT_HEADINGS'), 'Expected doc to mention SOAK_REPEAT_HEADINGS');
  assert(doc.includes('SOAK_SECTION_LENGTH'), 'Expected doc to mention SOAK_SECTION_LENGTH');

  const script = readFileSync('scripts/staging-collab-projection-soak.ts', 'utf8');
  assert(script.includes('buildMixedHtmlFixture'), 'Expected soak script to define buildMixedHtmlFixture');
  assert(script.includes('[soak] result=failed'), 'Expected soak script to log failed result');
  assert(script.includes('SOAK_LIVE_VIEWERS'), 'Expected soak script to read SOAK_LIVE_VIEWERS');
  assert(script.includes('SOAK_MUTATION_MODE'), 'Expected soak script to read SOAK_MUTATION_MODE');
  assert(script.includes('SOAK_DOC_COMPLEXITY'), 'Expected soak script to read SOAK_DOC_COMPLEXITY');
  assert(script.includes('SOAK_REPEAT_HEADINGS'), 'Expected soak script to read SOAK_REPEAT_HEADINGS');
  assert(script.includes('SOAK_SECTION_LENGTH'), 'Expected soak script to read SOAK_SECTION_LENGTH');

  console.log('✓ complex-doc projection soak harness documented');
}

try {
  run();
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}
