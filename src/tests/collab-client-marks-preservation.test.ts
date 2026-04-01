import { shouldPreserveMissingLocalMark } from '../bridge/marks-preservation';

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

function run(): void {
  assert(
    shouldPreserveMissingLocalMark({
      kind: 'replace',
      by: 'ai:test',
      status: 'pending',
      quote: 'old',
      content: 'new',
    }) === false,
    'Expected pending replace suggestions not to be preserved when missing from server metadata',
  );

  assert(
    shouldPreserveMissingLocalMark({
      kind: 'insert',
      by: 'ai:test',
      status: 'pending',
      quote: 'old',
      content: 'new',
    }) === false,
    'Expected pending insert suggestions not to be preserved when missing from server metadata',
  );

  assert(
    shouldPreserveMissingLocalMark({
      kind: 'delete',
      by: 'ai:test',
      status: 'pending',
      quote: 'old',
    }) === false,
    'Expected pending delete suggestions not to be preserved when missing from server metadata',
  );

  assert(
    shouldPreserveMissingLocalMark({
      kind: 'comment',
      by: 'ai:test',
      text: 'keep this',
      resolved: false,
    }) === true,
    'Expected comment marks to remain preservable for partial payload safety',
  );

  assert(
    shouldPreserveMissingLocalMark({
      kind: 'authored',
      by: 'human:test',
    }) === false,
    'Expected authored marks never to be preserved',
  );

  console.log('✓ collab client mark preservation rules avoid suggestion resurrection');
}

run();
