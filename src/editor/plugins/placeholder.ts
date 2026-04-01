import { $prose } from '@milkdown/kit/utils';
import { Plugin, PluginKey } from '@milkdown/kit/prose/state';
import { Decoration, DecorationSet } from '@milkdown/kit/prose/view';

const placeholderKey = new PluginKey('placeholder');

function isDocEmpty(doc: any): boolean {
  if (doc.childCount === 0) return true;
  if (doc.childCount === 1) {
    const child = doc.firstChild;
    if (child && child.type.name === 'paragraph' && child.content.size === 0) return true;
  }
  return false;
}

export const placeholderPlugin = $prose(() => {
  return new Plugin({
    key: placeholderKey,
    props: {
      decorations(state) {
        if (!isDocEmpty(state.doc)) return DecorationSet.empty;

        const firstNode = state.doc.firstChild;
        if (!firstNode) return DecorationSet.empty;

        const decoration = Decoration.node(0, firstNode.nodeSize, {
          class: 'is-editor-empty',
          'data-placeholder': 'Start writing...',
        });

        return DecorationSet.create(state.doc, [decoration]);
      },
    },
  });
});
