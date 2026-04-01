/**
 * Batch Executor for Atomic Operations
 *
 * Executes multiple operations in a single ProseMirror transaction.
 * Operations share context (cursor, selection) and are either all
 * committed or all rolled back.
 */

import type { EditorView } from '@milkdown/kit/prose/view';
import type { Transaction } from '@milkdown/kit/prose/state';
import type { Node, Fragment } from '@milkdown/kit/prose/model';
import {
  resolveSelector,
  resolveSelectorRange,
  hasHeading,
  extractHeadingFromText,
  type SelectorRange,
} from './utils/selectors';
import { setAgentCursor, setAgentSelection } from './plugins/agent-cursor';
import { captureEvent } from '../analytics/telemetry';

// Types

export interface BatchOperation {
  op: 'select' | 'goto' | 'insert' | 'replace' | 'delete' | 'save';
  selector?: string;
  text?: string;
  at?: string;
  from?: number;
  to?: number;
  skipIfHeadingExists?: boolean;
  skipIfContentExists?: boolean;
}

export interface BatchOperationResult {
  op: string;
  success: boolean;
  error?: string;
  from?: number;
  to?: number;
  offset?: number;
  skipped?: boolean;
  reason?: string;
}

export interface BatchResult {
  success: boolean;
  results: BatchOperationResult[];
  error?: string;
}

interface BatchContext {
  tr: Transaction;
  selection: SelectorRange | null;
  cursor: number;
  saveAfter: boolean;
}

type Parser = (text: string) => Node;

/**
 * Execute a batch of operations atomically.
 *
 * All operations are applied to a single transaction. If any operation
 * fails, the transaction is not dispatched and the document remains unchanged.
 */
export function executeBatch(
  view: EditorView,
  parser: Parser,
  operations: BatchOperation[]
): BatchResult {
  const results: BatchOperationResult[] = [];

  // Initialize context with current state
  const ctx: BatchContext = {
    tr: view.state.tr,
    selection: null,
    cursor: view.state.selection.from,
    saveAfter: false,
  };

  // Execute each operation sequentially
  for (let i = 0; i < operations.length; i++) {
    const op = operations[i];
    const result = executeOperation(ctx, view, parser, op);
    results.push(result);

    if (!result.success && !result.skipped) {
      // Operation failed - don't dispatch, return error
      return {
        success: false,
        error: `Operation ${i + 1} (${op.op}) failed: ${result.error}`,
        results,
      };
    }
  }

  // All operations succeeded - dispatch the transaction
  if (ctx.tr.docChanged) {
    view.dispatch(ctx.tr);
  }

  // Handle save if requested
  if (ctx.saveAfter) {
    captureEvent('document_save_requested', {
      source: 'batch_executor',
      save_supported: false,
      operations_count: operations.length,
    });
  }

  return {
    success: true,
    results,
  };
}

/**
 * Execute a single operation, updating the context.
 */
function executeOperation(
  ctx: BatchContext,
  view: EditorView,
  parser: Parser,
  op: BatchOperation
): BatchOperationResult {
  switch (op.op) {
    case 'goto':
      return executeGoto(ctx, view, op);
    case 'select':
      return executeSelect(ctx, view, op);
    case 'insert':
      return executeInsert(ctx, parser, op);
    case 'replace':
      return executeReplace(ctx, parser, op);
    case 'delete':
      return executeDelete(ctx, op);
    case 'save':
      return executeSave(ctx);
    default:
      return { op: op.op, success: false, error: `Unknown operation: ${op.op}` };
  }
}

/**
 * Move agent cursor to a position.
 */
function executeGoto(
  ctx: BatchContext,
  view: EditorView,
  op: BatchOperation
): BatchOperationResult {
  const selector = op.selector || 'cursor';
  const position = resolveSelector(ctx.tr.doc, selector, {
    cursor: ctx.cursor,
    selection: ctx.selection,
  });

  if (position === null) {
    return { op: 'goto', success: false, error: `Could not resolve selector: ${selector}` };
  }

  // Update context cursor
  ctx.cursor = position;

  // Set visual agent cursor
  setAgentCursor(view, position);

  return { op: 'goto', success: true, offset: position };
}

/**
 * Select a range for subsequent operations.
 */
function executeSelect(
  ctx: BatchContext,
  view: EditorView,
  op: BatchOperation
): BatchOperationResult {
  let range: SelectorRange | null = null;

  // Try selector first
  if (op.selector) {
    range = resolveSelectorRange(ctx.tr.doc, op.selector, {
      cursor: ctx.cursor,
      selection: ctx.selection,
    });
  }

  // Or use explicit from/to
  if (!range && op.from !== undefined && op.to !== undefined) {
    range = { from: op.from, to: op.to };
  }

  if (!range) {
    return {
      op: 'select',
      success: false,
      error: `Could not resolve selection: ${op.selector || 'no selector'}`,
    };
  }

  // Clamp to document bounds
  const docSize = ctx.tr.doc.content.size;
  range.from = Math.max(0, Math.min(range.from, docSize));
  range.to = Math.max(0, Math.min(range.to, docSize));

  // Update context
  ctx.selection = range;
  ctx.cursor = range.from;

  // Set visual agent selection
  setAgentSelection(view, range.from, range.to);

  return { op: 'select', success: true, from: range.from, to: range.to };
}

/**
 * Insert text at a position.
 */
function executeInsert(
  ctx: BatchContext,
  parser: Parser,
  op: BatchOperation
): BatchOperationResult {
  const text = op.text || '';

  // Check for deduplication
  if (op.skipIfHeadingExists) {
    const heading = extractHeadingFromText(text);
    if (heading && hasHeading(ctx.tr.doc, heading)) {
      return {
        op: 'insert',
        success: true,
        skipped: true,
        reason: 'Heading already exists',
      };
    }
  }

  // Determine insert position
  let insertPos: number | null = null;

  if (op.at) {
    insertPos = resolveSelector(ctx.tr.doc, op.at, {
      cursor: ctx.cursor,
      selection: ctx.selection,
    });
  } else if (ctx.selection) {
    // Insert at end of selection
    insertPos = ctx.selection.to;
  } else {
    // Insert at cursor
    insertPos = ctx.cursor;
  }

  if (insertPos === null) {
    return { op: 'insert', success: false, error: `Could not resolve insert position` };
  }

  // Clamp to document bounds
  const docSize = ctx.tr.doc.content.size;
  insertPos = Math.max(0, Math.min(insertPos, docSize));

  // Parse and insert
  const newContent = parser(text);
  ctx.tr = ctx.tr.insert(insertPos, newContent.content);

  // Update context - cursor moves to end of inserted content
  const insertedSize = newContent.content.size;
  ctx.cursor = insertPos + insertedSize;
  ctx.selection = { from: insertPos, to: ctx.cursor };

  return { op: 'insert', success: true, offset: insertPos };
}

/**
 * Replace a range with new text.
 */
function executeReplace(
  ctx: BatchContext,
  parser: Parser,
  op: BatchOperation
): BatchOperationResult {
  const text = op.text || '';

  // Determine range to replace
  let range: SelectorRange | null = null;

  if (op.selector) {
    range = resolveSelectorRange(ctx.tr.doc, op.selector, {
      cursor: ctx.cursor,
      selection: ctx.selection,
    });
  } else if (ctx.selection) {
    range = ctx.selection;
  }

  if (!range) {
    return {
      op: 'replace',
      success: false,
      error: 'No selection or selector provided for replace',
    };
  }

  // Clamp to document bounds
  const docSize = ctx.tr.doc.content.size;
  range.from = Math.max(0, Math.min(range.from, docSize));
  range.to = Math.max(0, Math.min(range.to, docSize));

  // Parse new content
  const newContent = parser(text);

  // Use replaceWith which DELETES old content then inserts new
  ctx.tr = ctx.tr.replaceWith(range.from, range.to, newContent.content);

  // Update context - selection is now the new content range
  const newSize = newContent.content.size;
  ctx.selection = { from: range.from, to: range.from + newSize };
  ctx.cursor = ctx.selection.to;

  return { op: 'replace', success: true, from: range.from, to: ctx.selection.to };
}

/**
 * Delete a range.
 */
function executeDelete(ctx: BatchContext, op: BatchOperation): BatchOperationResult {
  // Determine range to delete
  let range: SelectorRange | null = null;

  if (op.selector) {
    range = resolveSelectorRange(ctx.tr.doc, op.selector, {
      cursor: ctx.cursor,
      selection: ctx.selection,
    });
  } else if (ctx.selection) {
    range = ctx.selection;
  }

  if (!range) {
    return {
      op: 'delete',
      success: false,
      error: 'No selection or selector provided for delete',
    };
  }

  // Clamp to document bounds
  const docSize = ctx.tr.doc.content.size;
  range.from = Math.max(0, Math.min(range.from, docSize));
  range.to = Math.max(0, Math.min(range.to, docSize));

  // Delete the range
  ctx.tr = ctx.tr.delete(range.from, range.to);

  // Update context
  ctx.selection = null;
  ctx.cursor = range.from;

  return { op: 'delete', success: true, from: range.from, to: range.to };
}

/**
 * Mark document for saving after batch completes.
 */
function executeSave(ctx: BatchContext): BatchOperationResult {
  ctx.saveAfter = true;
  return { op: 'save', success: true };
}
