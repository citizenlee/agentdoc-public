/**
 * Table Keyboard Plugin
 *
 * Two-step Backspace behavior for table rows:
 * 1. Empty rows: Backspace deletes the row immediately
 * 2. Cursor at start of first cell: Backspace selects the entire row (native selection)
 * 3. Entire row already selected: Backspace deletes the row
 *
 * Uses TextSelection (native browser highlight) instead of CellSelection
 * so the selection looks like a normal system selection.
 */

import { $prose } from '@milkdown/kit/utils';
import { Plugin, PluginKey, TextSelection } from '@milkdown/kit/prose/state';
import type { EditorView } from '@milkdown/kit/prose/view';
import { CellSelection, deleteRow } from '@milkdown/prose/tables';
import type { Node as ProseMirrorNode } from '@milkdown/kit/prose/model';

const tableKeyboardKey = new PluginKey('table-keyboard');

function isRowEffectivelyEmpty(row: ProseMirrorNode): boolean {
  let empty = true;
  row.forEach((cell) => {
    cell.content.forEach((paragraph) => {
      paragraph.forEach((inline) => {
        if (inline.type.name === 'hardbreak') return;
        if (inline.isText && inline.text?.trim() === '') return;
        empty = false;
      });
    });
  });
  return empty;
}

function findRowAndCheckStart($from: any): {
  rowDepth: number;
  isAtStart: boolean;
  isFirstCell: boolean;
} | null {
  for (let d = $from.depth; d > 0; d--) {
    const node = $from.node(d);
    if (node.type.name === 'table_row') {
      const rowStart = $from.start(d);
      const offsetInRow = $from.pos - rowStart;

      let cellIndex = -1;
      let accum = 0;
      for (let i = 0; i < node.childCount; i++) {
        const cellSize = node.child(i).nodeSize;
        if (offsetInRow < accum + cellSize) {
          cellIndex = i;
          break;
        }
        accum += cellSize;
      }

      const isFirstCell = cellIndex === 0;
      const cellStart = rowStart + accum;
      const cursorInCell = $from.pos - cellStart;
      const isAtStart = cursorInCell <= 2;

      return { rowDepth: d, isAtStart, isFirstCell };
    }
  }
  return null;
}

/**
 * Get the text content range of a row: from start of first cell's text
 * to end of last cell's text.
 */
function getRowTextRange(row: ProseMirrorNode, rowContentStart: number): { from: number; to: number } | null {
  if (row.childCount === 0) return null;

  // First cell: position of first text content
  // rowContentStart is $from.start(rowDepth), i.e. right after the row opening
  // First cell starts at rowContentStart, cell content at +1, paragraph at +2
  const firstTextStart = rowContentStart + 2; // cell open + paragraph open

  // Last cell: end of text content
  let lastCellStart = rowContentStart;
  for (let i = 0; i < row.childCount - 1; i++) {
    lastCellStart += row.child(i).nodeSize;
  }
  const lastCell = row.child(row.childCount - 1);
  // End of last cell text = lastCellStart + cell nodeSize - 2 (paragraph close + cell close)
  const lastTextEnd = lastCellStart + lastCell.nodeSize - 2;

  return { from: firstTextStart, to: lastTextEnd };
}

/**
 * Check if a TextSelection spans exactly one table row's full content.
 */
function isRowTextSelection(state: any): { rowDepth: number } | null {
  const sel = state.selection;
  if (sel.from === sel.to) return null; // collapsed cursor
  if (sel instanceof CellSelection) return null;

  const $from = state.doc.resolve(sel.from);
  const $to = state.doc.resolve(sel.to);

  // Both ends must be inside the same table_row
  for (let d = $from.depth; d > 0; d--) {
    const node = $from.node(d);
    if (node.type.name === 'table_row') {
      // Check $to is in the same row
      const rowStart = $from.start(d);
      const rowEnd = rowStart + node.content.size;
      if (sel.to > rowEnd) return null; // selection extends beyond this row

      // Check it spans the full row text
      const range = getRowTextRange(node, rowStart);
      if (!range) return null;
      if (sel.from === range.from && sel.to === range.to) {
        return { rowDepth: d };
      }
      return null;
    }
  }
  return null;
}

/** Core handler — exported for programmatic testing */
export function handleTableBackspace(view: EditorView): boolean {
  const state = view.state;
  const sel = state.selection;

  // Case 1a: CellSelection row selected → delete it (fallback for programmatic use)
  if (sel instanceof CellSelection && sel.isRowSelection()) {
    const $anchor = sel.$anchorCell;
    let tableDepth = -1;
    for (let d = $anchor.depth; d > 0; d--) {
      if ($anchor.node(d).type.name === 'table') {
        tableDepth = d;
        break;
      }
    }
    if (tableDepth >= 0) {
      const table = $anchor.node(tableDepth);
      const dataRows = table.childCount - 1;
      if (dataRows <= 1) return false;
      deleteRow(state, view.dispatch);
      return true;
    }
  }

  // Case 1b: TextSelection spanning full row → delete it
  const rowSel = isRowTextSelection(state);
  if (rowSel) {
    const $from = state.doc.resolve(sel.from);
    const table = $from.node(rowSel.rowDepth - 1);
    const dataRows = table.childCount - 1;
    if (dataRows <= 1) return false;
    // Place cursor in the row first so deleteRow knows which row
    const rowStart = $from.start(rowSel.rowDepth);
    const tr = state.tr.setSelection(TextSelection.create(state.doc, rowStart + 2));
    view.dispatch(tr);
    deleteRow(view.state, view.dispatch);
    return true;
  }

  // Only handle collapsed cursor from here
  if (sel.from !== sel.to) return false;
  if (sel instanceof CellSelection) return false;

  const { $from } = sel;
  const info = findRowAndCheckStart($from);
  if (!info) return false;

  const row = $from.node(info.rowDepth);

  // Case 2: Empty row → delete immediately
  if (isRowEffectivelyEmpty(row)) {
    const table = $from.node(info.rowDepth - 1);
    const dataRows = table.childCount - 1;
    if (dataRows <= 1) return false;
    deleteRow(state, view.dispatch);
    return true;
  }

  // Case 3: Cursor at start of first cell → select entire row with native TextSelection
  if (info.isFirstCell && info.isAtStart) {
    const rowStart = $from.start(info.rowDepth);
    const range = getRowTextRange(row, rowStart);
    if (!range) return false;

    const textSel = TextSelection.create(state.doc, range.from, range.to);
    view.dispatch(state.tr.setSelection(textSel));
    return true;
  }

  return false;
}

export const tableKeyboardPlugin = $prose(() => {
  return new Plugin({
    key: tableKeyboardKey,
    props: {
      handleDOMEvents: {
        keydown(view: EditorView, event: KeyboardEvent) {
          if (event.key !== 'Backspace') return false;
          const handled = handleTableBackspace(view);
          if (handled) {
            event.preventDefault();
            return true;
          }
          return false;
        },
      },
    },
  });
});
