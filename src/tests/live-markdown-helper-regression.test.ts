import * as Y from 'yjs';
import { yXmlFragmentToProseMirrorRootNode } from 'y-prosemirror';
import { getHeadlessMilkdownParser, serializeMarkdown } from '../../server/milkdown-headless.ts';
import { replaceLiveMarkdown } from '../shared/live-markdown.ts';

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

async function run(): Promise<void> {
  const parser = await getHeadlessMilkdownParser();
  const ydoc = new Y.Doc();
  const markdown = '# Helper Regression\n\nUpdated through shared helper.';

  replaceLiveMarkdown(ydoc, markdown, parser, 'test-helper');

  assert(
    ydoc.getText('markdown').toString() === markdown,
    `Expected markdown text channel to match helper input.\nExpected:\n${markdown}\n\nActual:\n${ydoc.getText('markdown').toString()}`,
  );

  const root = yXmlFragmentToProseMirrorRootNode(
    ydoc.getXmlFragment('prosemirror') as any,
    parser.schema as any,
  );
  const serialized = await serializeMarkdown(root as any);
  assert(
    serialized.includes('Helper Regression') && serialized.includes('Updated through shared helper.'),
    `Expected helper to replace fragment state too.\nSerialized fragment markdown:\n${serialized}`,
  );

  console.log('✓ shared live-markdown helper updates markdown and fragment together');
}

run().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exit(1);
});
