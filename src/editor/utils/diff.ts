/**
 * Pure diff utility functions for line-based change detection.
 * Used by the editor for external change display and by tests.
 */

export interface LineDiffChange {
  type: 'insert' | 'delete' | 'replace';
  oldText?: string;   // For delete/replace: the original text
  newText?: string;   // For insert/replace: the new text
  anchorText?: string; // For inserts: preceding line to anchor after
  // Line index spans (0-based, inclusive start, exclusive end)
  oldLineStart?: number;  // First old line index affected
  oldLineEnd?: number;    // One past last old line index affected
  newLineStart?: number;  // First new line index affected
  newLineEnd?: number;    // One past last new line index affected
}

/**
 * Simple line-based diff using longest common subsequence.
 * Returns a list of changes (insert, delete, replace) with context for anchoring.
 */
export function computeLineDiff(oldLines: string[], newLines: string[]): LineDiffChange[] {
  // Build LCS table
  const m = oldLines.length;
  const n = newLines.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (oldLines[i - 1] === newLines[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
  }

  // Backtrack to find diff operations
  const changes: LineDiffChange[] = [];
  let i = m, j = n;

  // Collect raw operations in reverse
  const ops: Array<{ type: 'keep' | 'delete' | 'insert'; oldIdx: number; newIdx: number }> = [];
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && oldLines[i - 1] === newLines[j - 1]) {
      ops.push({ type: 'keep', oldIdx: i - 1, newIdx: j - 1 });
      i--; j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      ops.push({ type: 'insert', oldIdx: i - 1, newIdx: j - 1 });
      j--;
    } else {
      ops.push({ type: 'delete', oldIdx: i - 1, newIdx: j - 1 });
      i--;
    }
  }
  ops.reverse();

  // Group adjacent deletes and inserts into replaces
  let idx = 0;
  let lastKeptLine = ''; // Track the last line we kept for anchoring inserts
  while (idx < ops.length) {
    const op = ops[idx];
    if (op.type === 'keep') {
      lastKeptLine = oldLines[op.oldIdx];
      idx++;
      continue;
    }

    // Collect consecutive deletes
    const deletedLines: string[] = [];
    let deleteOldStart = -1;
    let deleteOldEnd = -1;
    while (idx < ops.length && ops[idx].type === 'delete') {
      const oi = ops[idx].oldIdx;
      if (deleteOldStart === -1) deleteOldStart = oi;
      deleteOldEnd = oi + 1;
      deletedLines.push(oldLines[oi]);
      idx++;
    }

    // Collect consecutive inserts
    const insertedLines: string[] = [];
    let insertNewStart = -1;
    let insertNewEnd = -1;
    let insertOldIdx = -1; // track where in oldLines the insert occurs
    while (idx < ops.length && ops[idx].type === 'insert') {
      const ni = ops[idx].newIdx;
      if (insertNewStart === -1) {
        insertNewStart = ni;
        insertOldIdx = ops[idx].oldIdx;
      }
      insertNewEnd = ni + 1;
      insertedLines.push(newLines[ni]);
      idx++;
    }

    if (deletedLines.length > 0 && insertedLines.length > 0) {
      // Replace: old lines → new lines
      changes.push({
        type: 'replace',
        oldText: deletedLines.join('\n'),
        newText: insertedLines.join('\n'),
        oldLineStart: deleteOldStart,
        oldLineEnd: deleteOldEnd,
        newLineStart: insertNewStart,
        newLineEnd: insertNewEnd,
      });
    } else if (deletedLines.length > 0) {
      changes.push({
        type: 'delete',
        oldText: deletedLines.join('\n'),
        oldLineStart: deleteOldStart,
        oldLineEnd: deleteOldEnd,
      });
    } else if (insertedLines.length > 0) {
      changes.push({
        type: 'insert',
        newText: insertedLines.join('\n'),
        anchorText: lastKeptLine,
        oldLineStart: insertOldIdx >= 0 ? insertOldIdx + 1 : 0,
        newLineStart: insertNewStart,
        newLineEnd: insertNewEnd,
      });
    }
  }

  return changes;
}

/**
 * Convert line index spans to character offsets within the text.
 * Lines are joined by '\n' separators, matching doc.textBetween() output.
 */
export function linesToCharOffsets(
  lines: string[],
  lineStart: number,
  lineEnd: number
): { from: number; to: number } {
  let from = 0;
  for (let i = 0; i < lineStart; i++) {
    from += lines[i].length + 1; // +1 for '\n' separator
  }
  let to = from;
  for (let i = lineStart; i < lineEnd; i++) {
    to += lines[i].length + (i < lineEnd - 1 ? 1 : 0);
  }
  return { from, to };
}

/**
 * Compute change statistics from diff output for mode classification.
 * Uses actual diff operation counts (not set-membership heuristics).
 */
export interface ChangeStats {
  totalLines: number;
  changedLines: number;
  changeRatio: number;
  clusters: number;
  insertedLines: number;
  deletedLines: number;
  replacedLines: number;
}

export function computeChangeStats(changes: LineDiffChange[], oldLines: string[], newLines: string[]): ChangeStats {
  let insertedLines = 0;
  let deletedLines = 0;
  let replacedLines = 0;

  for (const change of changes) {
    if (change.type === 'insert') {
      insertedLines += (change.newText?.split('\n').length ?? 0);
    } else if (change.type === 'delete') {
      deletedLines += (change.oldText?.split('\n').length ?? 0);
    } else if (change.type === 'replace') {
      replacedLines += Math.max(
        change.oldText?.split('\n').length ?? 0,
        change.newText?.split('\n').length ?? 0
      );
    }
  }

  const changedLines = insertedLines + deletedLines + replacedLines;
  const totalLines = Math.max(oldLines.length, newLines.length, 1);

  return {
    totalLines,
    changedLines,
    changeRatio: changedLines / totalLines,
    clusters: changes.length,
    insertedLines,
    deletedLines,
    replacedLines,
  };
}

/**
 * Classify whether changes should be shown as highlights or a full refresh.
 * Thresholds: >30% changed lines → refresh, >15 clusters → refresh.
 */
export function classifyChangeMode(stats: ChangeStats): 'highlights' | 'refresh' {
  // Refresh if >30% of lines changed
  if (stats.changeRatio > 0.3) return 'refresh';
  // Too many scattered changes = hard to review individually
  if (stats.clusters > 15) return 'refresh';
  return 'highlights';
}

/**
 * Rewrite endpoint mode classification.
 *
 * More aggressive than classifyChangeMode because /rewrite is agent-driven and
 * should avoid partial diffs for medium/large structural edits.
 */
export function classifyRewriteMode(stats: ChangeStats): 'highlights' | 'refresh' {
  // Structural rewrites often sit in the 20-30% range and are risky as marks.
  if (stats.changeRatio > 0.2) return 'refresh';
  // Many change clusters are hard to review as a pile of isolated suggestions.
  if (stats.clusters > 8) return 'refresh';
  // Large absolute deltas should refresh even in long documents.
  if (stats.changedLines > 40) return 'refresh';
  return 'highlights';
}
