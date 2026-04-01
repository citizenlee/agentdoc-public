import { readFileSync } from 'node:fs';
import path from 'node:path';

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

function run(): void {
  const source = readFileSync(path.resolve(process.cwd(), 'server/collab.ts'), 'utf8');

  const applyStart = source.indexOf('async function applyCanonicalDocumentToCollabInner(');
  assert(applyStart >= 0, 'Expected applyCanonicalDocumentToCollabInner');

  const applyBody = source.slice(applyStart, applyStart + 5000);
  const rememberIndex = applyBody.indexOf('rememberLoadedDoc(slug, ydoc);');
  const metaIndex = applyBody.indexOf('setLoadedDocDbMeta(');
  const skipIndex = applyBody.indexOf('markSkipNextOnStorePersist(slug, ydoc);');

  assert(rememberIndex >= 0, 'Expected external apply path to remember loaded doc');
  assert(metaIndex >= 0, 'Expected external apply path to refresh loaded DB metadata');
  assert(skipIndex >= 0, 'Expected external apply path to mark skip-next onStore persist');
  assert(
    rememberIndex < metaIndex && metaIndex < skipIndex,
    'Expected external apply path to refresh loaded DB metadata before skip-next onStore guard',
  );

  assert(
    applyBody.includes('getDocumentBySlug(slug)'),
    'Expected external apply path to read current canonical row before reseeding loaded metadata',
  );

  console.log('✓ collab external apply baseline refresh wiring checks');
}

try {
  run();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
