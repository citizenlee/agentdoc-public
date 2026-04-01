import * as Y from 'yjs';
import { prosemirrorToYXmlFragment } from 'y-prosemirror';

export type LiveMarkdownParser = {
  parseMarkdown: (markdown: string) => unknown;
};

export function replaceLiveMarkdown(
  ydoc: Y.Doc,
  markdown: string,
  parser: LiveMarkdownParser,
  origin: string,
): void {
  ydoc.transact(() => {
    const text = ydoc.getText('markdown');
    if (text.length > 0) text.delete(0, text.length);
    text.insert(0, markdown);

    const fragment = ydoc.getXmlFragment('prosemirror');
    if (fragment.length > 0) fragment.delete(0, fragment.length);
    prosemirrorToYXmlFragment(parser.parseMarkdown(markdown) as any, fragment as any);
  }, origin);
}
