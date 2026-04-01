/**
 * Tests for YAML Frontmatter + Provenance Interaction
 *
 * Verifies that:
 * - YAML frontmatter does not corrupt Agentdoc provenance/marks at document bottom
 * - Frontmatter is preserved during extraction pipeline
 * - Provenance extraction works correctly with frontmatter present
 * - Marks extraction works correctly with frontmatter present
 * - Round-trip: frontmatter survives extract → parse → serialize cycle
 */

import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkStringify from 'remark-stringify';
import remarkFrontmatter from 'remark-frontmatter';
import { extractEmbeddedProvenance } from '../formats/provenance-sidecar.js';
import { extractMarks, embedMarks, type StoredMark } from '../formats/marks.js';
import {
  stripFrontmatterDelimiters,
  wrapFrontmatterValue,
} from '../editor/schema/frontmatter.js';

// Simple test runner
let passed = 0;
let failed = 0;

function test(name: string, fn: () => void) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failed++;
    console.error(`  ✗ ${name}`);
    console.error(`    ${(error as Error).message}`);
  }
}

function assert(condition: boolean, message: string) {
  if (!condition) {
    throw new Error(message);
  }
}

function assertEqual<T>(actual: T, expected: T, message?: string) {
  if (actual !== expected) {
    throw new Error(message || `Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function assertIncludes(haystack: string, needle: string, message?: string) {
  if (!haystack.includes(needle)) {
    throw new Error(message || `Expected string to include ${JSON.stringify(needle)}, but it was not found`);
  }
}

function assertNotIncludes(haystack: string, needle: string, message?: string) {
  if (haystack.includes(needle)) {
    throw new Error(message || `Expected string NOT to include ${JSON.stringify(needle)}, but it was found`);
  }
}

// ============================================================================
// Test Helpers
// ============================================================================

function makeProvenance(spans: Array<{ startOffset: number; endOffset: number; origin: string }> = []) {
  return {
    version: '2.1.0',
    documentId: 'test-doc',
    created: '2025-01-01T00:00:00Z',
    modified: '2025-01-01T00:00:00Z',
    spans: spans.map((s, i) => ({
      spanId: `span-${i}`,
      ...s,
      attestation: 'A0',
      authorId: 'test-author',
      createdAt: '2025-01-01T00:00:00Z',
    })),
    attention: {},
    events: [],
    metadata: { humanPercent: 100, aiPercent: 0, attestationCoverage: {} },
    comments: [],
  };
}

function wrapWithProvenance(content: string, provenance?: object): string {
  const prov = provenance ?? makeProvenance();
  const json = JSON.stringify(prov, null, 2);
  let c = content;
  if (!c.endsWith('\n')) c += '\n';
  return `${c}\n<!-- AGENTDOC:END -->\n\n<!-- PROVENANCE\n${json}\n-->\n`;
}

function wrapWithMarks(content: string, marks: Record<string, StoredMark>): string {
  return embedMarks(content, marks);
}

const SIMPLE_FRONTMATTER = `---
title: Test Document
author: Dan Shipper
date: 2025-01-15
---`;

const COMPLEX_FRONTMATTER = `---
title: "Complex: A Document with Special Characters"
author: Dan Shipper
tags:
  - writing
  - ai
  - provenance
metadata:
  draft: true
  version: 3
---`;

const SIMPLE_BODY = `# Hello World

This is a test document with some content.

Here is another paragraph.`;

const SAMPLE_MARKS: Record<string, StoredMark> = {
  'm1': {
    kind: 'comment',
    by: 'human:dan',
    createdAt: '2025-01-01T00:00:00Z',
    text: 'Nice paragraph',
    threadId: 't1',
    thread: [],
    resolved: false,
  },
  'm2': {
    kind: 'insert',
    by: 'ai:claude',
    createdAt: '2025-01-01T00:00:00Z',
    content: ' additional text',
    status: 'pending',
  },
};

// ============================================================================
// 1. Provenance Extraction with Frontmatter
// ============================================================================

console.log('\n=== Provenance Extraction with Frontmatter ===');

test('extractEmbeddedProvenance correctly extracts provenance from doc with frontmatter', () => {
  const input = `${SIMPLE_FRONTMATTER}\n\n${SIMPLE_BODY}`;
  const withProv = wrapWithProvenance(input);
  const { content, provenance } = extractEmbeddedProvenance(withProv);

  assert(provenance !== null, 'Provenance should be extracted');
  assertEqual(provenance!.documentId, 'test-doc');
  assertNotIncludes(content, '<!-- PROVENANCE', 'Content should not contain provenance block');
});

test('extractEmbeddedProvenance preserves frontmatter in content after stripping provenance', () => {
  const input = `${SIMPLE_FRONTMATTER}\n\n${SIMPLE_BODY}`;
  const withProv = wrapWithProvenance(input);
  const { content } = extractEmbeddedProvenance(withProv);

  assertIncludes(content, '---', 'Content should still contain frontmatter delimiters');
  assertIncludes(content, 'title: Test Document', 'Content should still contain frontmatter fields');
  assertIncludes(content, 'author: Dan Shipper', 'Content should still contain author field');
});

test('extractEmbeddedProvenance does not confuse frontmatter --- with provenance markers', () => {
  const input = `${SIMPLE_FRONTMATTER}\n\n${SIMPLE_BODY}`;
  const withProv = wrapWithProvenance(input);
  const { content, provenance } = extractEmbeddedProvenance(withProv);

  // The frontmatter should remain intact in content
  const lines = content.split('\n');
  assertEqual(lines[0], '---', 'First line should be frontmatter opening ---');
  assert(provenance !== null, 'Provenance should still be extracted');
  assertIncludes(content, 'Hello World', 'Body content should remain');
});

test('extractEmbeddedProvenance with complex frontmatter and provenance', () => {
  const input = `${COMPLEX_FRONTMATTER}\n\n${SIMPLE_BODY}`;
  const withProv = wrapWithProvenance(input);
  const { content, provenance } = extractEmbeddedProvenance(withProv);

  assert(provenance !== null, 'Provenance should be extracted');
  assertIncludes(content, 'tags:', 'Content should preserve YAML list fields');
  assertIncludes(content, '  - writing', 'Content should preserve YAML list items');
  assertIncludes(content, 'metadata:', 'Content should preserve nested YAML');
});

test('extractEmbeddedProvenance with frontmatter only (no provenance)', () => {
  const input = `${SIMPLE_FRONTMATTER}\n\n${SIMPLE_BODY}`;
  const { content, provenance } = extractEmbeddedProvenance(input);

  assertEqual(provenance, null, 'Provenance should be null');
  assertIncludes(content, '---', 'Frontmatter should be preserved');
  assertIncludes(content, 'title: Test Document', 'Frontmatter fields preserved');
});

// ============================================================================
// 2. Marks Extraction with Frontmatter
// ============================================================================

console.log('\n=== Marks Extraction with Frontmatter ===');

test('extractMarks correctly extracts marks from doc with frontmatter', () => {
  const input = `${SIMPLE_FRONTMATTER}\n\n${SIMPLE_BODY}`;
  const withMarks = wrapWithMarks(input, SAMPLE_MARKS);
  const { content, marks } = extractMarks(withMarks);

  assert(Object.keys(marks).length > 0, 'Marks should be extracted');
  assertEqual(marks['m1']?.kind, 'comment');
  assertEqual(marks['m2']?.kind, 'insert');
  assertNotIncludes(content, '<!-- AGENTDOC', 'Content should not contain marks block');
});

test('extractMarks preserves frontmatter in content after stripping marks', () => {
  const input = `${SIMPLE_FRONTMATTER}\n\n${SIMPLE_BODY}`;
  const withMarks = wrapWithMarks(input, SAMPLE_MARKS);
  const { content } = extractMarks(withMarks);

  assertIncludes(content, '---', 'Frontmatter delimiters preserved');
  assertIncludes(content, 'title: Test Document', 'Frontmatter fields preserved');
  assertIncludes(content, 'Hello World', 'Body content preserved');
});

test('extractMarks with complex frontmatter and marks', () => {
  const input = `${COMPLEX_FRONTMATTER}\n\n${SIMPLE_BODY}`;
  const withMarks = wrapWithMarks(input, SAMPLE_MARKS);
  const { content, marks } = extractMarks(withMarks);

  assert(Object.keys(marks).length === 2, 'Both marks should be extracted');
  assertIncludes(content, 'tags:', 'Frontmatter YAML list preserved');
  assertIncludes(content, '  - ai', 'Frontmatter list items preserved');
});

// ============================================================================
// 3. Combined Pipeline: Provenance + Marks + Frontmatter
// ============================================================================

console.log('\n=== Combined Pipeline (Provenance + Marks + Frontmatter) ===');

test('full pipeline: frontmatter + marks + provenance all extracted correctly', () => {
  const bodyContent = `${SIMPLE_FRONTMATTER}\n\n${SIMPLE_BODY}`;

  // Add marks to the content
  const withMarks = wrapWithMarks(bodyContent, SAMPLE_MARKS);
  // Then add provenance on top
  const withAll = wrapWithProvenance(withMarks);

  // Step 1: Extract provenance (same as loadDocument)
  const { content: provenanceStripped, provenance } = extractEmbeddedProvenance(withAll);
  assert(provenance !== null, 'Provenance should be extracted');

  // Step 2: Extract marks
  const { content: cleanContent, marks } = extractMarks(provenanceStripped);
  assert(Object.keys(marks).length === 2, 'Marks should be extracted');

  // Step 3: Verify clean content has frontmatter but no metadata blocks
  assertIncludes(cleanContent, '---', 'Frontmatter preserved after full pipeline');
  assertIncludes(cleanContent, 'title: Test Document', 'Frontmatter fields preserved');
  assertIncludes(cleanContent, 'Hello World', 'Body content preserved');
  assertNotIncludes(cleanContent, '<!-- PROVENANCE', 'No provenance block in clean content');
  assertNotIncludes(cleanContent, '<!-- AGENTDOC', 'No marks block in clean content');
});

test('pipeline order: provenance first, then marks - both extracted cleanly', () => {
  const content = `${SIMPLE_FRONTMATTER}\n\n${SIMPLE_BODY}`;
  const withMarks = wrapWithMarks(content, { 'm1': SAMPLE_MARKS['m1'] });
  const withAll = wrapWithProvenance(withMarks);

  const { content: step1, provenance } = extractEmbeddedProvenance(withAll);
  const { content: step2, marks } = extractMarks(step1);

  assert(provenance !== null, 'Provenance extracted in step 1');
  assert(marks['m1'] !== undefined, 'Mark extracted in step 2');
  assertIncludes(step2, 'title: Test Document', 'Frontmatter survives both extractions');
});

// ============================================================================
// 4. Frontmatter Delimiter Handling
// ============================================================================

console.log('\n=== Frontmatter Delimiter Handling ===');

test('frontmatter --- delimiters do not interfere with provenance regex', () => {
  // This is the key bug scenario: --- in frontmatter should NOT match provenance patterns
  const content = [
    '---',
    'title: Test',
    '---',
    '',
    'Body text here.',
    '',
    '<!-- PROVENANCE',
    JSON.stringify(makeProvenance(), null, 2),
    '-->',
    '',
  ].join('\n');

  const { content: stripped, provenance } = extractEmbeddedProvenance(content);

  assert(provenance !== null, 'Provenance should be found despite frontmatter ---');
  assertIncludes(stripped, '---', 'Frontmatter --- should remain in content');
  assertIncludes(stripped, 'title: Test', 'Frontmatter field should remain');
  assertNotIncludes(stripped, '<!-- PROVENANCE', 'Provenance block should be removed');
});

test('frontmatter with ... end delimiter does not affect provenance', () => {
  const content = [
    '---',
    'title: Test',
    '...',
    '',
    'Body text.',
    '',
    '<!-- PROVENANCE',
    JSON.stringify(makeProvenance(), null, 2),
    '-->',
    '',
  ].join('\n');

  const { content: stripped, provenance } = extractEmbeddedProvenance(content);

  assert(provenance !== null, 'Provenance should be extracted');
  assertIncludes(stripped, 'title: Test', 'Frontmatter preserved');
});

test('multiple --- in document (frontmatter + horizontal rules) do not confuse extraction', () => {
  const content = [
    '---',
    'title: Test',
    '---',
    '',
    '# Section 1',
    '',
    'Some text.',
    '',
    '---',
    '',
    '# Section 2',
    '',
    'More text.',
  ].join('\n');

  const withProv = wrapWithProvenance(content);
  const { content: stripped, provenance } = extractEmbeddedProvenance(withProv);

  assert(provenance !== null, 'Provenance extracted despite multiple ---');
  // Count --- occurrences - frontmatter has 2, plus 1 horizontal rule
  const dashes = stripped.split('\n').filter(line => line.trim() === '---');
  assert(dashes.length >= 3, `Should have at least 3 --- lines (frontmatter open/close + hr), got ${dashes.length}`);
});

// ============================================================================
// 5. Frontmatter Schema Utilities
// ============================================================================

console.log('\n=== Frontmatter Schema Utilities ===');

test('stripFrontmatterDelimiters removes --- wrapping', () => {
  const input = '---\ntitle: Test\nauthor: Dan\n---';
  const result = stripFrontmatterDelimiters(input);
  assertEqual(result, 'title: Test\nauthor: Dan');
});

test('stripFrontmatterDelimiters handles ... end delimiter', () => {
  const input = '---\ntitle: Test\n...';
  const result = stripFrontmatterDelimiters(input);
  assertEqual(result, 'title: Test');
});

test('stripFrontmatterDelimiters returns input unchanged when no delimiters', () => {
  const input = 'title: Test\nauthor: Dan';
  const result = stripFrontmatterDelimiters(input);
  assertEqual(result, input);
});

test('stripFrontmatterDelimiters handles leading whitespace', () => {
  const input = '\n\n---\ntitle: Test\n---';
  const result = stripFrontmatterDelimiters(input);
  assertEqual(result, 'title: Test');
});

test('wrapFrontmatterValue wraps bare YAML in delimiters', () => {
  const input = 'title: Test\nauthor: Dan';
  const result = wrapFrontmatterValue(input);
  assertEqual(result, '---\ntitle: Test\nauthor: Dan\n---');
});

test('wrapFrontmatterValue does not double-wrap already delimited YAML', () => {
  const input = '---\ntitle: Test\n---';
  const result = wrapFrontmatterValue(input);
  assertEqual(result, input);
});

test('wrapFrontmatterValue handles empty value', () => {
  const result = wrapFrontmatterValue('');
  assertEqual(result, '---\n---');
});

// ============================================================================
// 6. Edge Cases
// ============================================================================

console.log('\n=== Edge Cases ===');

test('empty frontmatter with provenance', () => {
  const content = '---\n---\n\nBody text.';
  const withProv = wrapWithProvenance(content);
  const { content: stripped, provenance } = extractEmbeddedProvenance(withProv);

  assert(provenance !== null, 'Provenance extracted with empty frontmatter');
  assertIncludes(stripped, 'Body text.', 'Body preserved');
});

test('frontmatter with YAML that looks like HTML comments', () => {
  const content = [
    '---',
    'title: "<!-- Not a comment -->"',
    'description: "Contains <!-- AGENTDOC in string"',
    '---',
    '',
    'Body text.',
  ].join('\n');

  const withProv = wrapWithProvenance(content);
  const { content: stripped, provenance } = extractEmbeddedProvenance(withProv);

  assert(provenance !== null, 'Provenance extracted despite HTML-like strings in frontmatter');
  assertIncludes(stripped, '<!-- Not a comment -->', 'YAML string with HTML comment preserved');
});

test('frontmatter with YAML containing PROVENANCE keyword', () => {
  const content = [
    '---',
    'title: PROVENANCE Test',
    'proof_type: provenance',
    '---',
    '',
    'Body text.',
  ].join('\n');

  const withProv = wrapWithProvenance(content);
  const { content: stripped, provenance } = extractEmbeddedProvenance(withProv);

  assert(provenance !== null, 'Provenance extracted despite keyword in frontmatter');
  assertIncludes(stripped, 'title: PROVENANCE Test', 'Frontmatter with keyword preserved');
});

test('document with frontmatter but no body, with provenance', () => {
  const content = '---\ntitle: Empty Doc\n---\n';
  const withProv = wrapWithProvenance(content);
  const { provenance } = extractEmbeddedProvenance(withProv);

  assert(provenance !== null, 'Provenance extracted from frontmatter-only doc');
});

test('document with frontmatter and marks but no provenance', () => {
  const content = `${SIMPLE_FRONTMATTER}\n\nSome text.`;
  const withMarks = wrapWithMarks(content, SAMPLE_MARKS);

  const { content: provenanceStripped, provenance } = extractEmbeddedProvenance(withMarks);
  assertEqual(provenance, null, 'No provenance to extract');

  const { content: cleanContent, marks } = extractMarks(provenanceStripped);
  assert(Object.keys(marks).length === 2, 'Marks extracted');
  assertIncludes(cleanContent, 'title: Test Document', 'Frontmatter preserved');
});

test('very large frontmatter with many fields does not interfere', () => {
  const fields = Array.from({ length: 50 }, (_, i) => `field_${i}: value_${i}`).join('\n');
  const content = `---\n${fields}\n---\n\nBody text.`;
  const withProv = wrapWithProvenance(content);
  const { content: stripped, provenance } = extractEmbeddedProvenance(withProv);

  assert(provenance !== null, 'Provenance extracted with large frontmatter');
  assertIncludes(stripped, 'field_0: value_0', 'First field preserved');
  assertIncludes(stripped, 'field_49: value_49', 'Last field preserved');
});

test('frontmatter with multiline YAML strings', () => {
  const content = [
    '---',
    'title: Test',
    'description: |',
    '  This is a multiline',
    '  description that spans',
    '  several lines.',
    'summary: >',
    '  This is a folded',
    '  string value.',
    '---',
    '',
    'Body content.',
  ].join('\n');

  const withProv = wrapWithProvenance(content);
  const { content: stripped, provenance } = extractEmbeddedProvenance(withProv);

  assert(provenance !== null, 'Provenance extracted with multiline YAML');
  assertIncludes(stripped, 'description: |', 'Multiline YAML preserved');
  assertIncludes(stripped, '  several lines.', 'Multiline content preserved');
});

test('CRLF line endings in frontmatter do not break extraction', () => {
  const content = '---\r\ntitle: Test\r\nauthor: Dan\r\n---\r\n\r\nBody text.';
  const withProv = wrapWithProvenance(content);
  const { provenance } = extractEmbeddedProvenance(withProv);

  assert(provenance !== null, 'Provenance extracted with CRLF frontmatter');
});

test('re-embedding marks after extraction preserves frontmatter', () => {
  const original = `${SIMPLE_FRONTMATTER}\n\n${SIMPLE_BODY}`;
  const withMarks = wrapWithMarks(original, SAMPLE_MARKS);

  // Extract
  const { content, marks } = extractMarks(withMarks);
  assertIncludes(content, 'title: Test Document', 'Frontmatter present after extraction');

  // Re-embed
  const reEmbedded = embedMarks(content, marks);
  assertIncludes(reEmbedded, 'title: Test Document', 'Frontmatter present after re-embedding');
  assertIncludes(reEmbedded, '<!-- AGENTDOC', 'Marks block present after re-embedding');

  // Extract again - should be idempotent
  const { content: content2, marks: marks2 } = extractMarks(reEmbedded);
  assertIncludes(content2, 'title: Test Document', 'Frontmatter survives round-trip');
  assertEqual(Object.keys(marks2).length, 2, 'Same marks after round-trip');
});

test('provenance round-trip with frontmatter is stable', () => {
  const original = `${SIMPLE_FRONTMATTER}\n\nBody text.`;
  const prov = makeProvenance([{ startOffset: 0, endOffset: 10, origin: 'human.written' }]);
  const withProv = wrapWithProvenance(original, prov);

  // Extract
  const { content, provenance } = extractEmbeddedProvenance(withProv);
  assert(provenance !== null, 'Provenance extracted');
  assertIncludes(content, 'title: Test Document', 'Frontmatter preserved');

  // The content should be the original without provenance block
  assertNotIncludes(content, '<!-- PROVENANCE', 'No provenance in content');
  assertIncludes(content, 'Body text.', 'Body preserved');
});

// ============================================================================
// 7. Regression: The Original Bug Scenario
// ============================================================================

console.log('\n=== Regression: Original Bug Scenario ===');

test('REGRESSION: loading file with YAML frontmatter does not corrupt AGENTDOC marks', () => {
  // Simulate a file with frontmatter, body, and marks (the bug scenario)
  const fileContent = [
    '---',
    'title: My Article',
    'author: Dan Shipper',
    'date: 2025-06-15',
    '---',
    '',
    '# Introduction',
    '',
    'This is the first paragraph of my article about AI and writing.',
    '',
    '## Main Section',
    '',
    'Here is the main content with important points.',
    '',
  ].join('\n');

  const withMarks = wrapWithMarks(fileContent, {
    'm1': {
      kind: 'authored',
      by: 'human:dan',
      createdAt: '2025-06-15T00:00:00Z',
    },
    'm2': {
      kind: 'comment',
      by: 'ai:claude',
      createdAt: '2025-06-15T00:00:00Z',
      text: 'Great opening!',
      threadId: 't1',
      thread: [],
      resolved: false,
    },
  });

  // Step 1: Extract provenance (none expected)
  const { content: step1, provenance } = extractEmbeddedProvenance(withMarks);
  assertEqual(provenance, null, 'No provenance in this file');

  // Step 2: Extract marks
  const { content: cleanContent, marks } = extractMarks(step1);

  // Verify marks are not corrupted
  assert(marks['m1'] !== undefined, 'Mark m1 should exist');
  assert(marks['m2'] !== undefined, 'Mark m2 should exist');
  assertEqual(marks['m1'].kind, 'authored');
  assertEqual(marks['m2'].kind, 'comment');
  assertEqual((marks['m2'] as any).text, 'Great opening!');

  // Verify frontmatter is intact
  assertIncludes(cleanContent, '---', 'Frontmatter delimiters present');
  assertIncludes(cleanContent, 'title: My Article', 'Title preserved');
  assertIncludes(cleanContent, 'author: Dan Shipper', 'Author preserved');
  assertIncludes(cleanContent, 'date: 2025-06-15', 'Date preserved');

  // Verify body content is intact
  assertIncludes(cleanContent, '# Introduction', 'Heading preserved');
  assertIncludes(cleanContent, 'first paragraph', 'Body content preserved');

  // Verify no metadata blocks leak into content
  assertNotIncludes(cleanContent, '<!-- AGENTDOC', 'No marks block in clean content');
  assertNotIncludes(cleanContent, '<!-- PROVENANCE', 'No provenance block in clean content');
});

test('REGRESSION: loading file with YAML + provenance does not lose provenance data', () => {
  const fileContent = [
    '---',
    'title: My Article',
    '---',
    '',
    'Hello world.',
  ].join('\n');

  const prov = makeProvenance([
    { startOffset: 0, endOffset: 12, origin: 'human.written' },
  ]);
  const withAll = wrapWithProvenance(fileContent, prov);

  const { content: step1, provenance } = extractEmbeddedProvenance(withAll);

  // Provenance must not be null - this is the core of the bug
  assert(provenance !== null, 'CRITICAL: Provenance must be extracted even with frontmatter');
  assertEqual(provenance!.spans.length, 1, 'Provenance spans preserved');
  assertEqual(provenance!.spans[0].origin, 'human.written', 'Span origin preserved');

  // Frontmatter must still be there
  assertIncludes(step1, 'title: My Article', 'Frontmatter not destroyed');
});

test('REGRESSION: marks + provenance + frontmatter full round-trip', () => {
  const fileContent = [
    '---',
    'title: Full Test',
    'tags:',
    '  - test',
    '  - roundtrip',
    '---',
    '',
    'First paragraph.',
    '',
    'Second paragraph.',
  ].join('\n');

  // Add marks
  const withMarks = wrapWithMarks(fileContent, SAMPLE_MARKS);
  // Add provenance
  const withAll = wrapWithProvenance(withMarks, makeProvenance([
    { startOffset: 0, endOffset: 16, origin: 'human.written' },
  ]));

  // Extract pipeline (same as loadDocument)
  const { content: step1, provenance } = extractEmbeddedProvenance(withAll);
  const { content: step2, marks } = extractMarks(step1);

  // Everything must be intact
  assert(provenance !== null, 'Provenance extracted');
  assert(provenance!.spans.length === 1, 'Provenance span preserved');
  assert(Object.keys(marks).length === 2, 'Marks extracted');
  assertIncludes(step2, 'title: Full Test', 'Frontmatter preserved');
  assertIncludes(step2, '  - test', 'YAML list items preserved');
  assertIncludes(step2, 'First paragraph.', 'Body preserved');
  assertNotIncludes(step2, '<!-- AGENTDOC', 'No marks in clean content');
  assertNotIncludes(step2, '<!-- PROVENANCE', 'No provenance in clean content');
});

// ============================================================================
// 8. Remark Pipeline: Parse → Serialize Round-Trip
//    These tests exercise the actual markdown parsing pipeline that the editor
//    uses, which would have caught the plugin ordering bug.
// ============================================================================

console.log('\n=== Remark Pipeline: Parse → Serialize Round-Trip ===');

/**
 * Create a remark processor with frontmatter support (same as the editor uses).
 * This simulates what Milkdown does internally with remark-frontmatter.
 */
function createProcessor() {
  return unified()
    .use(remarkParse)
    .use(remarkFrontmatter, ['yaml'])
    .use(remarkStringify);
}

test('remark parses YAML frontmatter as a yaml AST node', () => {
  const input = '---\ntitle: Test\nauthor: Dan\n---\n\n# Hello\n\nBody text.';
  const processor = createProcessor();
  const tree = processor.parse(input);
  const yamlNode = (tree as any).children.find((n: any) => n.type === 'yaml');

  assert(yamlNode !== undefined, 'Should have a yaml AST node');
  assertEqual(yamlNode.type, 'yaml');
  assertIncludes(yamlNode.value, 'title: Test', 'YAML value includes title');
  assertIncludes(yamlNode.value, 'author: Dan', 'YAML value includes author');
});

test('remark preserves body content after frontmatter', () => {
  const input = '---\ntitle: Test\n---\n\n# Hello\n\nBody text.';
  const processor = createProcessor();
  const tree = processor.parse(input);
  const children = (tree as any).children;

  // Should have: yaml node, heading node, paragraph node
  assert(children.length >= 3, `Should have at least 3 top-level nodes, got ${children.length}`);
  assertEqual(children[0].type, 'yaml', 'First node is yaml');
  assertEqual(children[1].type, 'heading', 'Second node is heading');
  assertEqual(children[2].type, 'paragraph', 'Third node is paragraph');
});

test('remark round-trips frontmatter through parse → stringify', () => {
  const input = '---\ntitle: Test\nauthor: Dan\n---\n\n# Hello\n\nBody text.\n';
  const processor = createProcessor();
  const output = processor.processSync(input).toString();

  assertIncludes(output, '---', 'Output has frontmatter delimiters');
  assertIncludes(output, 'title: Test', 'Output has title field');
  assertIncludes(output, 'author: Dan', 'Output has author field');
  assertIncludes(output, '# Hello', 'Output has heading');
  assertIncludes(output, 'Body text.', 'Output has body');
});

test('remark round-trips complex frontmatter with lists', () => {
  const input = '---\ntitle: Test\ntags:\n  - a\n  - b\n---\n\nParagraph.\n';
  const processor = createProcessor();
  const output = processor.processSync(input).toString();

  assertIncludes(output, 'title: Test', 'Title preserved');
  assertIncludes(output, 'tags:', 'Tags key preserved');
  assertIncludes(output, 'Paragraph.', 'Body preserved');
});

test('remark without frontmatter plugin treats --- as thematic break', () => {
  // This test documents what happens WITHOUT the frontmatter plugin
  // (i.e., the bug scenario before our fix)
  const input = '---\ntitle: Test\n---\n\n# Hello\n\nBody text.';
  const noFrontmatter = unified()
    .use(remarkParse)
    .use(remarkStringify);
  const tree = noFrontmatter.parse(input);
  const children = (tree as any).children;

  // Without frontmatter plugin, --- is parsed as thematicBreak
  const hasYaml = children.some((n: any) => n.type === 'yaml');
  const hasThematicBreak = children.some((n: any) => n.type === 'thematicBreak');

  assert(!hasYaml, 'Without plugin, there should be no yaml node');
  assert(hasThematicBreak, 'Without plugin, --- should be a thematic break');
});

test('remark with frontmatter plugin does NOT produce thematic break for ---', () => {
  const input = '---\ntitle: Test\n---\n\n# Hello\n\nBody text.';
  const processor = createProcessor();
  const tree = processor.parse(input);
  const children = (tree as any).children;

  const hasYaml = children.some((n: any) => n.type === 'yaml');
  const hasThematicBreak = children.some((n: any) => n.type === 'thematicBreak');

  assert(hasYaml, 'With plugin, should have yaml node');
  assert(!hasThematicBreak, 'With plugin, frontmatter --- should NOT be thematic break');
});

test('remark round-trips SKILL.md-style frontmatter with long description', () => {
  const input = [
    '---',
    'name: claude-prompt-improver',
    'description: Delegate prompt engineering to Claude Code (Opus) when creating prompts.',
    '---',
    '',
    '# Claude Prompt Improver',
    '',
    'Use Claude Code (Opus) as a prompt-engineering copilot.',
    '',
    '## Quick Start',
    '',
    '```bash',
    'echo "hello"',
    '```',
    '',
  ].join('\n');

  const processor = createProcessor();
  const tree = processor.parse(input);

  // Verify yaml node exists and body is not consumed
  const children = (tree as any).children;
  assertEqual(children[0].type, 'yaml', 'First node is yaml (frontmatter)');
  assert(children.length >= 4, `Should have at least 4 nodes (yaml, heading, para, heading), got ${children.length}`);

  // Verify round-trip
  const output = processor.processSync(input).toString();
  assertIncludes(output, 'name: claude-prompt-improver', 'Name preserved');
  assertIncludes(output, '# Claude Prompt Improver', 'Heading preserved');
  assertIncludes(output, '```bash', 'Code block preserved');
  assertIncludes(output, 'echo "hello"', 'Code content preserved');
  assertIncludes(output, '## Quick Start', 'Subheading preserved');
});

test('remark frontmatter + marks extraction pipeline produces correct content', () => {
  // This simulates the full pipeline: file with frontmatter + marks →
  // extract marks → parse with remark → serialize → verify round-trip
  const fileContent = [
    '---',
    'title: Pipeline Test',
    '---',
    '',
    '# Test',
    '',
    'Content here.',
  ].join('\n');

  const withMarks = embedMarks(fileContent, SAMPLE_MARKS);

  // Step 1: Extract marks (like loadDocument does)
  const { content: cleanContent, marks } = extractMarks(withMarks);
  assert(Object.keys(marks).length === 2, 'Marks extracted');

  // Step 2: Parse with remark (like the editor does)
  const processor = createProcessor();
  const tree = processor.parse(cleanContent);
  const children = (tree as any).children;
  assertEqual(children[0].type, 'yaml', 'Remark parses frontmatter as yaml node');
  assert(children.length >= 3, 'Remark produces body nodes after frontmatter');

  // Step 3: Serialize back (like getMarkdownSnapshot does)
  const serialized = processor.processSync(cleanContent).toString();
  assertIncludes(serialized, 'title: Pipeline Test', 'Frontmatter survives full pipeline');
  assertIncludes(serialized, '# Test', 'Heading survives');
  assertIncludes(serialized, 'Content here.', 'Body survives');
  assertNotIncludes(serialized, '<!-- AGENTDOC', 'No marks in serialized output');

  // Step 4: Re-embed marks (like save does)
  const final = embedMarks(serialized, marks);
  assertIncludes(final, 'title: Pipeline Test', 'Frontmatter in final output');
  assertIncludes(final, '<!-- AGENTDOC', 'Marks re-embedded');
});

// ============================================================================
// Summary
// ============================================================================

console.log('\n=== Summary ===');
console.log(`Total: ${passed + failed}`);
console.log(`Passed: ${passed}`);
console.log(`Failed: ${failed}`);

if (failed > 0) {
  process.exit(1);
}
