import { extractAuthoredMarksFromMarkdown } from '../../server/agentdoc-authored-mark-sync.ts';

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

function assertEqual<T>(actual: T, expected: T, message?: string): void {
  if (actual !== expected) {
    throw new Error(message ?? `Expected ${String(expected)}, got ${String(actual)}`);
  }
}

async function run(): Promise<void> {
  const markdown = '<span data-proof="authored" data-proof-id="authored-before" data-by="human:test">Hello</span> world';
  const authored = await extractAuthoredMarksFromMarkdown(markdown);
  assert(authored !== null, 'Expected authored markdown extraction to succeed');
  assert('authored-before' in authored, 'Expected explicit authored id to round-trip from markdown');
  assertEqual(authored['authored-before']?.quote, 'Hello', 'Expected authored quote to match visible text');
  assertEqual(authored['authored-before']?.startRel, 'char:0', 'Expected authored startRel to use visible-text offsets');
  assertEqual(authored['authored-before']?.endRel, 'char:5', 'Expected authored endRel to use visible-text offsets');
  console.log('agentdoc-authored-mark-sync.test.ts passed');
}

run().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
