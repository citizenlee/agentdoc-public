import { applyAgentEditOperations } from '../../server/agent-edit-ops.js';
import { stripAgentdocSpanTags } from '../../server/agentdoc-span-strip.js';

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

function assertIncludes(haystack: string, needle: string, message?: string): void {
  if (!haystack.includes(needle)) {
    throw new Error(message ?? `Expected ${JSON.stringify(haystack)} to include ${JSON.stringify(needle)}`);
  }
}

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let index = 0;
  while (true) {
    const next = haystack.indexOf(needle, index);
    if (next < 0) return count;
    count += 1;
    index = next + needle.length;
  }
}

function test(name: string, fn: () => void): void {
  try {
    fn();
    console.log('  ✓', name);
  } catch (error) {
    console.error('  ✗', name);
    console.error(error instanceof Error ? error.stack : String(error));
    process.exitCode = 1;
  }
}

test('append inserts content before next heading', () => {
  const input = '# Title\n\n## Dan\n\nHello\n\n## Next\n\nWorld\n';
  const result = applyAgentEditOperations(input, [
    { op: 'append', section: 'Dan', content: 'More' },
  ], { by: 'ai:r2c2' });
  assert(result.ok, 'Expected ok');
  assertIncludes(result.markdown, '## Dan', 'Should keep heading');
  const danIdx = result.markdown.indexOf('## Dan');
  const nextIdx = result.markdown.indexOf('## Next');
  assert(danIdx >= 0 && nextIdx > danIdx, 'Expected headings present');
  const between = result.markdown.slice(danIdx, nextIdx);
  assertIncludes(between, 'More', 'Expected appended content within Dan section');
});

test('append creates section when missing', () => {
  const input = '# Title\n\nNothing here\n';
  const result = applyAgentEditOperations(input, [
    { op: 'append', section: 'Dan', content: 'Hello' },
  ], { by: 'ai:r2c2' });
  assert(result.ok, 'Expected ok');
  assertIncludes(result.markdown, '## Dan', 'Expected new section heading');
  assertIncludes(result.markdown, 'Hello', 'Expected content');
});

test('append matches numbered heading labels without duplicating section', () => {
  const input = '# Daily\n\n## 4. Agent Collaboration Strategy\n\n- existing\n\n## Next\n\n- more\n';
  const result = applyAgentEditOperations(input, [
    { op: 'append', section: 'Agent Collaboration Strategy', content: 'New strategy note' },
  ], { by: 'ai:r2c2' });
  assert(result.ok, 'Expected ok');
  assert(
    countOccurrences(result.markdown, '## 4. Agent Collaboration Strategy') === 1,
    'Expected numbered target heading to remain single',
  );
  assert(
    countOccurrences(result.markdown, '## Agent Collaboration Strategy') === 0,
    'Expected no unnumbered duplicate heading',
  );
  assertIncludes(result.markdown, 'New strategy note', 'Expected appended content to be present');
});

test('replace returns 409 structure when anchor missing', () => {
  const input = '# Title\n\nHello\n';
  const result = applyAgentEditOperations(input, [
    { op: 'replace', search: 'MISSING', content: 'x' },
  ]);
  assert(!result.ok, 'Expected not ok');
  assert(result.code === 'ANCHOR_NOT_FOUND', 'Expected ANCHOR_NOT_FOUND');
});

test('replace substitutes first occurrence', () => {
  const input = 'a a a';
  const result = applyAgentEditOperations(input, [
    { op: 'replace', search: 'a', content: 'b' },
  ]);
  assert(result.ok, 'Expected ok');
  assert(result.markdown.startsWith('b'), 'Expected first a replaced');
});

test('insert after heading inserts with spacing', () => {
  const input = '# Title\n\n## Brain dump\n\nHello\n';
  const result = applyAgentEditOperations(input, [
    { op: 'insert', after: '## Brain dump', content: 'Inserted' },
  ]);
  assert(result.ok, 'Expected ok');
  assertIncludes(result.markdown, '## Brain dump\n\nInserted', 'Expected inserted content after heading');
});

test('insert after repeated anchor targets first occurrence deterministically', () => {
  const input = [
    '# Daily Plan',
    '',
    '## Thursday, Feb 26, 2026',
    '',
    '* [ ] Process Lucas\'s stakeholder synthesis dashboard',
    '',
    '## Wednesday, Feb 25, 2026',
    '',
    '* [ ] Process Lucas\'s stakeholder synthesis dashboard',
    '',
  ].join('\n');
  const marker = '* [ ] REPRO_MARKER';
  const result = applyAgentEditOperations(input, [
    { op: 'insert', after: 'Process Lucas\'s stakeholder synthesis dashboard', content: `\n\n${marker}` },
  ]);
  assert(result.ok, 'Expected ok');
  assert(countOccurrences(result.markdown, marker) === 1, 'Expected marker to be inserted exactly once');
  const firstAnchor = result.markdown.indexOf('Process Lucas\'s stakeholder synthesis dashboard');
  const secondAnchor = result.markdown.indexOf('Process Lucas\'s stakeholder synthesis dashboard', firstAnchor + 1);
  const markerIndex = result.markdown.indexOf(marker);
  assert(markerIndex > firstAnchor, 'Expected marker after first anchor');
  assert(markerIndex < secondAnchor, 'Expected marker to remain before second anchor');
});

test('authored wrapper is applied for inline inserts', () => {
  const input = '# Title\n\n## Dan\n\nHello\n';
  const result = applyAgentEditOperations(input, [
    { op: 'append', section: 'Dan', content: 'Inline text' },
  ], { by: 'ai:r2c2' });
  assert(result.ok, 'Expected ok');
  assertIncludes(result.markdown, 'data-agentdoc="authored"', 'Expected authored wrapper');
  assertIncludes(result.markdown, 'data-by="ai:r2c2"', 'Expected authored by');
});

test('authored wrapper is applied for literal symbol text', () => {
  const input = '# Title\n\n## Dan\n\nHello\n';
  const result = applyAgentEditOperations(input, [
    { op: 'append', section: 'Dan', content: '2 * 3 = 6 and this has a lone backtick ` symbol.' },
  ], { by: 'ai:r2c2' });
  assert(result.ok, 'Expected ok');
  assertIncludes(result.markdown, 'data-agentdoc="authored"', 'Expected authored wrapper for literal symbols');
});

test('authored wrapper is skipped for inline markdown formatting', () => {
  const input = '# Title\n\n## Dan\n\nHello\n';
  const result = applyAgentEditOperations(input, [
    { op: 'append', section: 'Dan', content: 'Use **bold** and `code` formatting' },
  ], { by: 'ai:r2c2' });
  assert(result.ok, 'Expected ok');
  assert(!result.markdown.includes('data-agentdoc="authored"'), 'Expected authored wrapper to be skipped for inline markdown');
});

test('authored wrapper is not applied inside fenced code blocks', () => {
  const input = '```js\nconsole.log("hi")\n```\nEND\n';
  const result = applyAgentEditOperations(input, [
    { op: 'insert', after: 'console.log("hi")', content: 'Inline text' },
  ], { by: 'ai:r2c2' });
  assert(result.ok, 'Expected ok');
  assert(!result.markdown.includes('data-agentdoc="authored"'), 'Expected authored wrapper to be skipped');
});

test('replace falls back to span-stripped matching', () => {
  // Simulate a document where a previous agent edit wrapped content in authored spans.
  const input = '| 2<span data-proof="authored" data-by="human:willie">.</span> | Token tracking per plus1 |';
  const result = applyAgentEditOperations(input, [
    { op: 'replace', search: '| 2. | Token tracking per plus1 |', content: '| 2. | Token tracking per Plus One |' },
  ]);
  assert(result.ok, 'Expected ok — span-stripped fallback should find the anchor');
  assertIncludes(result.markdown, 'Plus One', 'Expected replaced content');
  assert(!result.markdown.includes('plus1'), 'Expected old content to be gone');
});

test('insert falls back to span-stripped matching', () => {
  const input = 'Hello <span data-proof="authored" data-by="ai:r2c2">world</span>. Goodbye.';
  const result = applyAgentEditOperations(input, [
    { op: 'insert', after: 'Hello world.', content: ' Beautiful day.' },
  ]);
  assert(result.ok, 'Expected ok — span-stripped fallback should find the anchor');
  assertIncludes(result.markdown, 'Beautiful day', 'Expected inserted content');
  const closeIdx = result.markdown.indexOf('</span>');
  const insertedIdx = result.markdown.indexOf('Beautiful day');
  assert(closeIdx >= 0 && insertedIdx > closeIdx, 'Expected insertion after the authored agentdoc span closes');
});

test('replace fully wrapped authored span replaces stale wrapper instead of nesting it', () => {
  const input = 'Hello <span data-proof="authored" data-by="ai:old">world</span>!';
  const result = applyAgentEditOperations(input, [
    { op: 'replace', search: 'world', content: 'earth' },
  ], { by: 'ai:new' });
  assert(result.ok, 'Expected ok');
  assertIncludes(result.markdown, 'data-by="ai:new"', 'Expected new authored wrapper');
  assert(!result.markdown.includes('data-by="ai:old"'), 'Expected stale authored wrapper to be removed');
  assert(countOccurrences(result.markdown, 'data-agentdoc="authored"') === 1, 'Expected only one authored wrapper');
  assertIncludes(
    result.markdown,
    'Hello <span data-agentdoc="authored" data-by="ai:new">earth</span>!',
    'Expected replacement to happen outside the stale wrapper',
  );
});

test('insert after fully wrapped authored span inserts outside the stale wrapper', () => {
  const input = 'Hello <span data-proof="authored" data-by="ai:old">world</span>!';
  const result = applyAgentEditOperations(input, [
    { op: 'insert', after: 'world', content: ' again' },
  ], { by: 'ai:new' });
  assert(result.ok, 'Expected ok');
  const staleCloseIdx = result.markdown.indexOf('</span>');
  const newWrapperIdx = result.markdown.indexOf('data-by="ai:new"');
  assert(staleCloseIdx >= 0, 'Expected stale wrapper to remain around original content');
  assert(newWrapperIdx > staleCloseIdx, 'Expected new authored insert to land outside the stale wrapper');
  assert(countOccurrences(result.markdown, 'data-agentdoc="authored"') === 2, 'Expected one stale and one new wrapper');
});

test('replace removes authored agentdoc tags for fully matched visible text', () => {
  const input = 'Hello <span data-proof="authored" data-by="ai:r2c2">world</span>. Goodbye.';
  const result = applyAgentEditOperations(input, [
    { op: 'replace', search: 'Hello world.', content: 'Hello universe.' },
  ], { by: 'ai:r2c2' });
  assert(result.ok, 'Expected ok — span-stripped replacement should find the visible text');
  assert(stripAgentdocSpanTags(result.markdown) === 'Hello universe. Goodbye.', `Expected stripped markdown to match visible text, got ${JSON.stringify(stripAgentdocSpanTags(result.markdown))}`);
  assert(countOccurrences(result.markdown, '<span') === countOccurrences(result.markdown, '</span>'), 'Expected balanced span tags after replacement');
  assert(!result.markdown.includes('world</span>'), 'Expected old authored span content to be fully replaced');
});

test('replace still fails when text genuinely missing', () => {
  const input = 'Hello <span data-proof="authored" data-by="ai:r2c2">world</span>';
  const result = applyAgentEditOperations(input, [
    { op: 'replace', search: 'DOES NOT EXIST', content: 'x' },
  ]);
  assert(!result.ok, 'Expected not ok');
  assert(result.code === 'ANCHOR_NOT_FOUND', 'Expected ANCHOR_NOT_FOUND');
});

if (process.exitCode) {
  process.exit(process.exitCode);
}
