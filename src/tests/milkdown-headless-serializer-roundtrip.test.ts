import { getHeadlessMilkdownParser, serializeMarkdown, serializeSingleNode } from '../../server/milkdown-headless.js';

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

async function run(): Promise<void> {
  const parser = await getHeadlessMilkdownParser();

  const markdown = [
    '---',
    'title: "Round Trip"',
    '---',
    '',
    '# Heading',
    '',
    'Paragraph with a <span data-proof="comment" data-id="m1" data-by="ai:test">marked phrase</span>.',
    '',
    '- [x] Task list item',
    '- Bullet item',
    '',
    '| a | b |',
    '| - | - |',
    '| 1 | 2 |',
    '',
    '```js proof:W10=',
    'console.log("ok")',
    '```',
    '',
  ].join('\n');

  const doc = parser.parseMarkdown(markdown);
  const serializedOnce = await serializeMarkdown(doc);
  const reparsed = parser.parseMarkdown(serializedOnce);
  const serializedTwice = await serializeMarkdown(reparsed);

  assert(
    serializedOnce === serializedTwice,
    'Expected serialize(parse(markdown)) to be stable across repeated round trips.',
  );
  assert(
    serializedOnce.includes('data-agentdoc="comment"'),
    'Expected agentdoc mark spans to serialize back into markdown.',
  );

  // GFM tables must survive the parse -> serialize round trip.
  // The serializer must produce pipe-delimited table rows for remark-gfm tables.
  assert(
    serializedOnce.includes('|'),
    'Expected GFM tables to survive serialization (pipe characters must be present).',
  );
  const pipeCount = (serializedOnce.match(/\|/g) || []).length;
  assert(
    pipeCount >= 6,
    `Expected at least 6 pipe characters for a 2x2 table, found ${pipeCount}.`,
  );

  const firstBlock = doc.childCount > 0 ? doc.child(0) : null;
  assert(firstBlock !== null, 'Expected parsed document to contain at least one block.');
  if (firstBlock) {
    const singleMarkdown = await serializeSingleNode(firstBlock);
    const singleDoc = parser.parseMarkdown(singleMarkdown);
    assert(
      singleDoc.childCount === 1,
      'Expected serializeSingleNode output to parse into exactly one top-level block.',
    );
  }

  console.log('✓ headless Milkdown serializer round-trip parity');
}

run().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
