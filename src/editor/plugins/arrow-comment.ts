import { $prose } from '@milkdown/kit/utils';
import { Plugin, PluginKey } from '@milkdown/kit/prose/state';
import type { EditorView } from '@milkdown/kit/prose/view';

import { openCommentComposer } from './mark-popover';
import type { MarkRange } from './marks';
import { getCurrentActor } from '../actor';
import { shouldUseCommentUiV2 } from './comment-ui-mode';

const arrowCommentKey = new PluginKey('arrow-comment');

function resolveBlockRange(view: EditorView, pos: number): MarkRange | null {
  const doc = view.state.doc;
  const clampedPos = Math.max(0, Math.min(pos, doc.content.size));
  const $pos = doc.resolve(clampedPos);

  for (let depth = $pos.depth; depth >= 0; depth -= 1) {
    const node = $pos.node(depth);
    if (node.isTextblock) {
      const from = $pos.start(depth);
      const to = $pos.end(depth);
      if (to > from) return { from, to };
      break;
    }
  }

  return null;
}

function isCodeContext(view: EditorView, pos: number): boolean {
  const doc = view.state.doc;
  const clampedPos = Math.max(0, Math.min(pos, doc.content.size));
  const $pos = doc.resolve(clampedPos);

  for (let depth = $pos.depth; depth >= 0; depth -= 1) {
    const node = $pos.node(depth);
    if (node.type.spec.code || node.type.name === 'code_block') {
      return true;
    }
  }

  const codeMark = view.state.schema.marks.code;
  if (!codeMark) return false;

  const nodeBeforeMarks = $pos.nodeBefore?.marks ?? [];
  if (nodeBeforeMarks.some(mark => mark.type === codeMark)) return true;

  const activeMarks = $pos.marks();
  return activeMarks.some(mark => mark.type === codeMark);
}

export const arrowCommentPlugin = $prose(() => {
  return new Plugin({
    key: arrowCommentKey,

    props: {
      handleTextInput(view, from, _to, text) {
        if (!shouldUseCommentUiV2()) return false;
        if (text !== '>') return false;
        if (from <= 0) return false;
        if (isCodeContext(view, from)) return false;

        const previousChar = view.state.doc.textBetween(from - 1, from, '', '');
        if (previousChar !== '-') return false;
        const preArrowChar = from >= 2 ? view.state.doc.textBetween(from - 2, from - 1, '', '') : '';
        if (preArrowChar.length > 0 && !/\s/.test(preArrowChar)) return false;

        const blockRange = resolveBlockRange(view, from - 1);
        if (!blockRange) return false;

        const tr = view.state.tr.delete(from - 1, from);
        view.dispatch(tr);

        openCommentComposer(view, blockRange, getCurrentActor());
        return true;
      },
    },
  });
});
