/**
 * Unit Tests for External Change Display System
 *
 * Tests:
 * - LineDiffChange line index spans
 * - linesToCharOffsets helper
 * - computeChangeStats
 * - classifyChangeMode thresholds
 * - computeLineDiff correctness
 * - EditSession type
 */

import {
  computeLineDiff,
  linesToCharOffsets,
  computeChangeStats,
  classifyChangeMode,
  classifyRewriteMode,
  type LineDiffChange,
  type ChangeStats,
} from '../editor/utils/diff';

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

function assertDeepEqual<T>(actual: T, expected: T, message?: string) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(message || `Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

// ============================================================================
// Tests
// ============================================================================

console.log('\n=== computeLineDiff ===');

test('identical documents produce no changes', () => {
  const lines = ['hello', 'world'];
  const changes = computeLineDiff(lines, lines);
  assertEqual(changes.length, 0);
});

test('single line insert is detected', () => {
  const old = ['line1', 'line3'];
  const nw = ['line1', 'line2', 'line3'];
  const changes = computeLineDiff(old, nw);
  assertEqual(changes.length, 1);
  assertEqual(changes[0].type, 'insert');
  assertEqual(changes[0].newText, 'line2');
  assertEqual(changes[0].anchorText, 'line1');
});

test('single line delete is detected', () => {
  const old = ['line1', 'line2', 'line3'];
  const nw = ['line1', 'line3'];
  const changes = computeLineDiff(old, nw);
  assertEqual(changes.length, 1);
  assertEqual(changes[0].type, 'delete');
  assertEqual(changes[0].oldText, 'line2');
});

test('single line replace is detected', () => {
  const old = ['line1', 'OLD', 'line3'];
  const nw = ['line1', 'NEW', 'line3'];
  const changes = computeLineDiff(old, nw);
  assertEqual(changes.length, 1);
  assertEqual(changes[0].type, 'replace');
  assertEqual(changes[0].oldText, 'OLD');
  assertEqual(changes[0].newText, 'NEW');
});

test('multiple scattered changes are detected', () => {
  const old = ['a', 'b', 'c', 'd', 'e'];
  const nw = ['a', 'B', 'c', 'D', 'e'];
  const changes = computeLineDiff(old, nw);
  assertEqual(changes.length, 2);
  assertEqual(changes[0].type, 'replace');
  assertEqual(changes[0].oldText, 'b');
  assertEqual(changes[0].newText, 'B');
  assertEqual(changes[1].type, 'replace');
  assertEqual(changes[1].oldText, 'd');
  assertEqual(changes[1].newText, 'D');
});

test('complete replacement is detected', () => {
  const old = ['a', 'b', 'c'];
  const nw = ['x', 'y', 'z'];
  const changes = computeLineDiff(old, nw);
  assertEqual(changes.length, 1);
  assertEqual(changes[0].type, 'replace');
});

console.log('\n=== Line Index Spans ===');

test('insert has correct line spans', () => {
  const old = ['line1', 'line3'];
  const nw = ['line1', 'line2', 'line3'];
  const changes = computeLineDiff(old, nw);
  assertEqual(changes[0].newLineStart, 1);
  assertEqual(changes[0].newLineEnd, 2);
});

test('delete has correct old line spans', () => {
  const old = ['line1', 'line2', 'line3'];
  const nw = ['line1', 'line3'];
  const changes = computeLineDiff(old, nw);
  assertEqual(changes[0].oldLineStart, 1);
  assertEqual(changes[0].oldLineEnd, 2);
});

test('replace has correct old and new line spans', () => {
  const old = ['line1', 'OLD_A', 'OLD_B', 'line4'];
  const nw = ['line1', 'NEW_A', 'NEW_B', 'NEW_C', 'line4'];
  const changes = computeLineDiff(old, nw);
  assertEqual(changes[0].type, 'replace');
  assertEqual(changes[0].oldLineStart, 1);
  assertEqual(changes[0].oldLineEnd, 3);
  assertEqual(changes[0].newLineStart, 1);
  assertEqual(changes[0].newLineEnd, 4);
});

test('multi-line insert has correct spans', () => {
  const old = ['a', 'd'];
  const nw = ['a', 'b', 'c', 'd'];
  const changes = computeLineDiff(old, nw);
  assertEqual(changes[0].type, 'insert');
  assertEqual(changes[0].newLineStart, 1);
  assertEqual(changes[0].newLineEnd, 3);
});

console.log('\n=== linesToCharOffsets ===');

test('first line offset is 0', () => {
  const lines = ['hello', 'world', 'foo'];
  const offsets = linesToCharOffsets(lines, 0, 1);
  assertEqual(offsets.from, 0);
  assertEqual(offsets.to, 5); // "hello" = 5 chars
});

test('second line offset accounts for newline separator', () => {
  const lines = ['hello', 'world', 'foo'];
  const offsets = linesToCharOffsets(lines, 1, 2);
  assertEqual(offsets.from, 6); // "hello\n" = 6
  assertEqual(offsets.to, 11); // "world" = 5, so 6+5=11
});

test('multi-line range includes intermediate newlines', () => {
  const lines = ['aaa', 'bbb', 'ccc'];
  const offsets = linesToCharOffsets(lines, 0, 3);
  assertEqual(offsets.from, 0);
  assertEqual(offsets.to, 11); // "aaa\nbbb\nccc" = 11 chars
});

test('single char lines', () => {
  const lines = ['a', 'b', 'c'];
  const offsets = linesToCharOffsets(lines, 1, 2);
  assertEqual(offsets.from, 2); // "a\n" = 2
  assertEqual(offsets.to, 3); // "b" = 1, so 2+1=3
});

test('last line offset', () => {
  const lines = ['hello', 'world'];
  const offsets = linesToCharOffsets(lines, 1, 2);
  assertEqual(offsets.from, 6);
  assertEqual(offsets.to, 11);
});

console.log('\n=== computeChangeStats ===');

test('no changes gives zero stats', () => {
  const stats = computeChangeStats([], ['a', 'b'], ['a', 'b']);
  assertEqual(stats.changedLines, 0);
  assertEqual(stats.changeRatio, 0);
  assertEqual(stats.clusters, 0);
});

test('single insert counted correctly', () => {
  const changes: LineDiffChange[] = [{
    type: 'insert',
    newText: 'new line',
    newLineStart: 1,
    newLineEnd: 2,
  }];
  const stats = computeChangeStats(changes, ['a'], ['a', 'new line']);
  assertEqual(stats.insertedLines, 1);
  assertEqual(stats.deletedLines, 0);
  assertEqual(stats.replacedLines, 0);
  assertEqual(stats.changedLines, 1);
  assertEqual(stats.clusters, 1);
});

test('replace counts max of old/new lines', () => {
  const changes: LineDiffChange[] = [{
    type: 'replace',
    oldText: 'old1\nold2',
    newText: 'new1\nnew2\nnew3',
    oldLineStart: 0,
    oldLineEnd: 2,
    newLineStart: 0,
    newLineEnd: 3,
  }];
  const stats = computeChangeStats(changes, ['old1', 'old2'], ['new1', 'new2', 'new3']);
  assertEqual(stats.replacedLines, 3); // max(2, 3) = 3
});

test('change ratio is correct', () => {
  // 10 lines, 3 changed → 0.3
  const changes: LineDiffChange[] = [
    { type: 'replace', oldText: 'a', newText: 'A' },
    { type: 'delete', oldText: 'b' },
    { type: 'insert', newText: 'c' },
  ];
  const oldLines = Array(10).fill('x');
  const newLines = Array(10).fill('x');
  const stats = computeChangeStats(changes, oldLines, newLines);
  assertEqual(stats.changedLines, 3);
  assertEqual(stats.changeRatio, 0.3);
});

console.log('\n=== classifyChangeMode ===');

test('low change ratio → highlights', () => {
  const stats: ChangeStats = {
    totalLines: 100,
    changedLines: 10,
    changeRatio: 0.1,
    clusters: 3,
    insertedLines: 5,
    deletedLines: 2,
    replacedLines: 3,
  };
  assertEqual(classifyChangeMode(stats), 'highlights');
});

test('change ratio at 0.3 boundary → highlights', () => {
  const stats: ChangeStats = {
    totalLines: 10,
    changedLines: 3,
    changeRatio: 0.3,
    clusters: 1,
    insertedLines: 0,
    deletedLines: 0,
    replacedLines: 3,
  };
  assertEqual(classifyChangeMode(stats), 'highlights');
});

test('change ratio >0.3 → refresh', () => {
  const stats: ChangeStats = {
    totalLines: 10,
    changedLines: 4,
    changeRatio: 0.4,
    clusters: 1,
    insertedLines: 0,
    deletedLines: 0,
    replacedLines: 4,
  };
  assertEqual(classifyChangeMode(stats), 'refresh');
});

test('10 changes with 5 clusters, low ratio → highlights', () => {
  const stats: ChangeStats = {
    totalLines: 100,
    changedLines: 10,
    changeRatio: 0.1,
    clusters: 5,
    insertedLines: 5,
    deletedLines: 2,
    replacedLines: 3,
  };
  assertEqual(classifyChangeMode(stats), 'highlights');
});

test('high ratio >0.3 with many changes → refresh', () => {
  const stats: ChangeStats = {
    totalLines: 100,
    changedLines: 60,
    changeRatio: 0.6,
    clusters: 8,
    insertedLines: 30,
    deletedLines: 10,
    replacedLines: 20,
  };
  assertEqual(classifyChangeMode(stats), 'refresh');
});

test('too many clusters → refresh', () => {
  const stats: ChangeStats = {
    totalLines: 100,
    changedLines: 20,
    changeRatio: 0.2,
    clusters: 16,
    insertedLines: 10,
    deletedLines: 5,
    replacedLines: 5,
  };
  assertEqual(classifyChangeMode(stats), 'refresh');
});

test('moderate changes below thresholds → highlights', () => {
  const stats: ChangeStats = {
    totalLines: 100,
    changedLines: 15,
    changeRatio: 0.15,
    clusters: 8,
    insertedLines: 5,
    deletedLines: 5,
    replacedLines: 5,
  };
  assertEqual(classifyChangeMode(stats), 'highlights');
});

console.log('\n=== classifyRewriteMode ===');

test('rewrite mode: low ratio + low clusters → highlights', () => {
  const stats: ChangeStats = {
    totalLines: 100,
    changedLines: 10,
    changeRatio: 0.1,
    clusters: 3,
    insertedLines: 4,
    deletedLines: 2,
    replacedLines: 4,
  };
  assertEqual(classifyRewriteMode(stats), 'highlights');
});

test('rewrite mode: ratio > 0.2 → refresh', () => {
  const stats: ChangeStats = {
    totalLines: 100,
    changedLines: 21,
    changeRatio: 0.21,
    clusters: 4,
    insertedLines: 10,
    deletedLines: 5,
    replacedLines: 6,
  };
  assertEqual(classifyRewriteMode(stats), 'refresh');
});

test('rewrite mode: clusters > 8 → refresh', () => {
  const stats: ChangeStats = {
    totalLines: 100,
    changedLines: 18,
    changeRatio: 0.18,
    clusters: 9,
    insertedLines: 6,
    deletedLines: 5,
    replacedLines: 7,
  };
  assertEqual(classifyRewriteMode(stats), 'refresh');
});

test('rewrite mode: changedLines > 40 → refresh', () => {
  const stats: ChangeStats = {
    totalLines: 300,
    changedLines: 41,
    changeRatio: 41 / 300,
    clusters: 7,
    insertedLines: 20,
    deletedLines: 8,
    replacedLines: 13,
  };
  assertEqual(classifyRewriteMode(stats), 'refresh');
});

console.log('\n=== Edge Cases ===');

test('empty old document (all inserts)', () => {
  const changes = computeLineDiff([], ['a', 'b', 'c']);
  assertEqual(changes.length, 1);
  assertEqual(changes[0].type, 'insert');
  assertEqual(changes[0].newText, 'a\nb\nc');
});

test('empty new document (all deletes)', () => {
  const changes = computeLineDiff(['a', 'b', 'c'], []);
  assertEqual(changes.length, 1);
  assertEqual(changes[0].type, 'delete');
  assertEqual(changes[0].oldText, 'a\nb\nc');
});

test('both empty', () => {
  const changes = computeLineDiff([], []);
  assertEqual(changes.length, 0);
});

test('single line to single line (same)', () => {
  const changes = computeLineDiff(['hello'], ['hello']);
  assertEqual(changes.length, 0);
});

test('single line to single line (different)', () => {
  const changes = computeLineDiff(['hello'], ['world']);
  assertEqual(changes.length, 1);
  assertEqual(changes[0].type, 'replace');
});

test('duplicate lines handled correctly', () => {
  // This is the key scenario that positional mapping fixes
  const old = ['paragraph', 'unique', 'paragraph'];
  const nw = ['paragraph', 'CHANGED', 'paragraph'];
  const changes = computeLineDiff(old, nw);
  assertEqual(changes.length, 1);
  assertEqual(changes[0].type, 'replace');
  assertEqual(changes[0].oldText, 'unique');
  assertEqual(changes[0].newText, 'CHANGED');
  // Verify spans point to the correct line
  assertEqual(changes[0].oldLineStart, 1);
  assertEqual(changes[0].oldLineEnd, 2);
});

test('insert at document start', () => {
  const old = ['existing'];
  const nw = ['new', 'existing'];
  const changes = computeLineDiff(old, nw);
  assertEqual(changes.length, 1);
  assertEqual(changes[0].type, 'insert');
  assertEqual(changes[0].newText, 'new');
});

test('delete at document end', () => {
  const old = ['keep', 'remove'];
  const nw = ['keep'];
  const changes = computeLineDiff(old, nw);
  assertEqual(changes.length, 1);
  assertEqual(changes[0].type, 'delete');
  assertEqual(changes[0].oldText, 'remove');
});

console.log('\n=== linesToCharOffsets + computeLineDiff integration ===');

test('char offsets match actual text positions', () => {
  const text = 'hello\nworld\nfoo';
  const lines = text.split('\n');

  // "world" is at lines[1]
  const offsets = linesToCharOffsets(lines, 1, 2);
  const extracted = text.slice(offsets.from, offsets.to);
  assertEqual(extracted, 'world');
});

test('char offsets for multi-line range', () => {
  const text = 'aaa\nbbb\nccc\nddd';
  const lines = text.split('\n');

  // lines[1..3] = "bbb\nccc"
  const offsets = linesToCharOffsets(lines, 1, 3);
  const extracted = text.slice(offsets.from, offsets.to);
  assertEqual(extracted, 'bbb\nccc');
});

test('diff + offsets recover correct text', () => {
  const oldText = 'line1\nOLD\nline3';
  const newText = 'line1\nNEW\nline3';
  const oldLines = oldText.split('\n');
  const newLines = newText.split('\n');

  const changes = computeLineDiff(oldLines, newLines);
  assertEqual(changes.length, 1);

  const offsets = linesToCharOffsets(oldLines, changes[0].oldLineStart!, changes[0].oldLineEnd!);
  const extracted = oldText.slice(offsets.from, offsets.to);
  assertEqual(extracted, 'OLD');
});

// ============================================================================
// Summary
// ============================================================================

console.log(`\n${passed} passed, ${failed} failed, ${passed + failed} total\n`);
if (failed > 0) {
  process.exit(1);
}
