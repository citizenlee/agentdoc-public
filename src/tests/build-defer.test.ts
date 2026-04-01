/**
 * Build-time assertion for defer + script attribute rewrite.
 */

import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void): void {
  try {
    fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`  ✗ ${name}`);
    console.error(`    ${(error as Error).message}`);
  }
}

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

const distIndexPath = resolve(process.cwd(), 'dist', 'index.html');

test('dist/index.html exists after build', () => {
  assert(existsSync(distIndexPath), `Missing dist/index.html at ${distIndexPath}`);
});

test('build output uses defer attribute on bundle script', () => {
  if (!existsSync(distIndexPath)) return;
  const html = readFileSync(distIndexPath, 'utf8');
  assert(html.includes(' defer '), 'index.html should include `defer` attribute (legacy rewrite expects spaced form)');
  assert(!html.includes('type="module" crossorigin'), 'index.html should not include Vite module script signature');
});

if (failed > 0) {
  console.error(`\n=== build defer test failed: ${failed} failed ===`);
  process.exit(1);
}

console.log(`\n=== build defer tests passed: ${passed} ===`);
