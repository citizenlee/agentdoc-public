const authoredAgentdocAttrRegex = /data-(?:proof|agentdoc)\s*=\s*(?:"authored"|'authored'|authored)/i;
const anyAgentdocAttrRegex = /data-(?:proof|agentdoc)\s*=\s*(?:"[^"]+"|'[^']+'|[^\s>]+)/i;

type AgentdocReplacementMark = {
  kind?: unknown;
  quote?: unknown;
};

type AuthoredSpanBounds = {
  openStart: number;
  contentStart: number;
  contentEnd: number;
  closeEnd: number;
};

type AgentdocRange = {
  id: string;
  start: number;
  end: number;
};

type StripStackEntry = {
  isAgentdoc: boolean;
  agentdocId: string | null;
  contentStart: number;
};

function isAuthoredAgentdocSpan(tag: string): boolean {
  return authoredAgentdocAttrRegex.test(tag);
}

function isAnyAgentdocSpan(tag: string): boolean {
  return anyAgentdocAttrRegex.test(tag);
}

function extractAgentdocSpanId(tag: string): string | null {
  const match = tag.match(/data-(?:agentdoc-)?id\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))/i)
    ?? tag.match(/data-proof-id\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))/i);
  const id = match?.[1] ?? match?.[2] ?? match?.[3] ?? null;
  return typeof id === 'string' && id.trim().length > 0 ? id.trim() : null;
}

function hasActiveSuppression(stack: Array<{ suppressContent: boolean }>): boolean {
  return stack.some((entry) => entry.suppressContent);
}

function collectStrippedAgentdocData(
  markdown: string,
  shouldStrip: (tag: string) => boolean,
): { stripped: string; agentdocRanges: AgentdocRange[] } {
  const spanTagRegex = /<\/?span\b[^>]*>/gi;
  const stack: StripStackEntry[] = [];
  const agentdocRanges: AgentdocRange[] = [];
  let result = '';
  let lastIndex = 0;

  for (const match of markdown.matchAll(spanTagRegex)) {
    const index = match.index ?? -1;
    if (index < 0) continue;
    const tag = match[0];
    result += markdown.slice(lastIndex, index);
    lastIndex = index + tag.length;

    if (tag.startsWith('</')) {
      if (stack.length === 0) {
        result += tag;
        continue;
      }
      const entry = stack.pop();
      if (!entry) continue;
      if (entry.isAgentdoc) {
        if (entry.agentdocId && result.length >= entry.contentStart) {
          agentdocRanges.push({
            id: entry.agentdocId,
            start: entry.contentStart,
            end: result.length,
          });
        }
      } else {
        result += tag;
      }
      continue;
    }

    const isAgentdoc = shouldStrip(tag);
    if (isAgentdoc) {
      stack.push({
        isAgentdoc: true,
        agentdocId: extractAgentdocSpanId(tag),
        contentStart: result.length,
      });
      continue;
    }

    result += tag;
    stack.push({
      isAgentdoc: false,
      agentdocId: null,
      contentStart: result.length,
    });
  }

  result += markdown.slice(lastIndex);
  return { stripped: result, agentdocRanges };
}

function mergeRanges(ranges: Array<{ start: number; end: number }>): Array<{ start: number; end: number }> {
  if (ranges.length === 0) return [];
  const sorted = ranges
    .filter((range) => range.end > range.start)
    .sort((a, b) => (a.start - b.start) || (a.end - b.end));
  if (sorted.length === 0) return [];

  const merged: Array<{ start: number; end: number }> = [{ ...sorted[0] }];
  for (let index = 1; index < sorted.length; index += 1) {
    const current = sorted[index];
    const last = merged[merged.length - 1];
    if (current.start <= last.end) {
      last.end = Math.max(last.end, current.end);
      continue;
    }
    merged.push({ ...current });
  }
  return merged;
}

function isGapFullyCovered(
  coverage: Array<{ start: number; end: number }>,
  start: number,
  end: number,
): boolean {
  if (end <= start) return true;
  let cursor = start;
  for (const range of coverage) {
    if (range.end <= cursor) continue;
    if (range.start > cursor) return false;
    cursor = Math.max(cursor, range.end);
    if (cursor >= end) return true;
  }
  return false;
}

function buildReplacementGroups(
  agentdocRanges: AgentdocRange[],
  replacementsById: Record<string, string>,
): Array<{ start: number; end: number; replacement: string }> {
  const replacementIds = Object.keys(replacementsById);
  if (replacementIds.length === 0 || agentdocRanges.length === 0) return [];

  const rangesById = new Map<string, AgentdocRange[]>();
  for (const range of agentdocRanges) {
    if (!(range.id in replacementsById) || range.end <= range.start) continue;
    const existing = rangesById.get(range.id);
    if (existing) {
      existing.push(range);
    } else {
      rangesById.set(range.id, [range]);
    }
  }

  const coverage = mergeRanges(agentdocRanges.map(({ start, end }) => ({ start, end })));
  const groups: Array<{ start: number; end: number; replacement: string }> = [];

  for (const [id, ranges] of rangesById.entries()) {
    const replacement = replacementsById[id];
    if (typeof replacement !== 'string') continue;
    const sorted = [...ranges].sort((a, b) => (a.start - b.start) || (a.end - b.end));
    let currentStart = sorted[0]?.start ?? -1;
    let currentEnd = sorted[0]?.end ?? -1;

    for (let index = 1; index < sorted.length; index += 1) {
      const next = sorted[index];
      if (next.start <= currentEnd || isGapFullyCovered(coverage, currentEnd, next.start)) {
        currentEnd = Math.max(currentEnd, next.end);
        continue;
      }
      if (currentEnd > currentStart) {
        groups.push({ start: currentStart, end: currentEnd, replacement });
      }
      currentStart = next.start;
      currentEnd = next.end;
    }

    if (currentEnd > currentStart) {
      groups.push({ start: currentStart, end: currentEnd, replacement });
    }
  }

  groups.sort((a, b) => (a.start - b.start) || (b.end - a.end));
  const selected: Array<{ start: number; end: number; replacement: string }> = [];
  for (const group of groups) {
    const previous = selected[selected.length - 1];
    if (previous && group.start >= previous.start && group.end <= previous.end) {
      continue;
    }
    selected.push(group);
  }
  return selected;
}

function applyReplacementGroups(
  stripped: string,
  groups: Array<{ start: number; end: number; replacement: string }>,
): string {
  if (groups.length === 0) return stripped;
  let result = '';
  let cursor = 0;
  for (const group of groups) {
    if (group.start < cursor) continue;
    result += stripped.slice(cursor, group.start);
    result += group.replacement;
    cursor = group.end;
  }
  result += stripped.slice(cursor);
  return result;
}

function stripAgentdocSpanTagsInternal(
  markdown: string,
  shouldStrip: (tag: string) => boolean,
  replacementsById?: Record<string, string>,
): string {
  if (replacementsById) {
    const { stripped, agentdocRanges } = collectStrippedAgentdocData(markdown, shouldStrip);
    return applyReplacementGroups(stripped, buildReplacementGroups(agentdocRanges, replacementsById));
  }

  const spanTagRegex = /<\/?span\b[^>]*>/gi;
  const agentdocStack: Array<{ isAgentdoc: boolean; suppressContent: boolean }> = [];
  let result = '';
  let lastIndex = 0;

  for (const match of markdown.matchAll(spanTagRegex)) {
    const index = match.index ?? -1;
    if (index < 0) continue;
    const tag = match[0];

    if (!hasActiveSuppression(agentdocStack)) {
      result += markdown.slice(lastIndex, index);
    }
    lastIndex = index + tag.length;

    const isClosing = tag.startsWith('</');
    if (isClosing) {
      if (agentdocStack.length === 0) {
        if (!hasActiveSuppression(agentdocStack)) {
          result += tag;
        }
        continue;
      }
      const entry = agentdocStack.pop();
      if (entry && !entry.isAgentdoc && !hasActiveSuppression(agentdocStack)) {
        result += tag;
      }
      continue;
    }

    const isAgentdoc = shouldStrip(tag);
    const replacementId = isAgentdoc ? extractAgentdocSpanId(tag) : null;
    const replacement = replacementId ? replacementsById?.[replacementId] : null;
    const suppressContent = Boolean(isAgentdoc && typeof replacement === 'string');
    agentdocStack.push({ isAgentdoc, suppressContent });
    if (suppressContent) {
      result += replacement;
    }
    if (!isAgentdoc) {
      if (!hasActiveSuppression(agentdocStack.slice(0, -1))) {
        result += tag;
      }
    }
  }

  if (!hasActiveSuppression(agentdocStack)) {
    result += markdown.slice(lastIndex);
  }
  return result;
}

/**
 * Strip Agentdoc-authored `<span data-proof="authored" ...>` HTML tags from markdown,
 * leaving the inner text content intact. Non-Agentdoc `<span>` tags are preserved.
 *
 * Used by:
 * - Agent snapshot endpoint (block markdown)
 * - Agent edit operations (anchor/search matching)
 * - Share text/markdown content negotiation
 */
export function stripAgentdocSpanTags(markdown: string): string {
  return stripAgentdocSpanTagsInternal(markdown, isAuthoredAgentdocSpan);
}

/**
 * Strip all Agentdoc `<span data-proof="...">` wrappers from markdown while preserving
 * their inner text. Non-Agentdoc spans remain intact.
 */
export function stripAllAgentdocSpanTags(markdown: string): string {
  return stripAgentdocSpanTagsInternal(markdown, isAnyAgentdocSpan);
}

export function stripAllAgentdocSpanTagsWithReplacements(
  markdown: string,
  replacementsById: Record<string, string>,
): string {
  return stripAgentdocSpanTagsInternal(markdown, isAnyAgentdocSpan, replacementsById);
}

export function buildAgentdocSpanReplacementMap<T extends AgentdocReplacementMark>(
  marks: Record<string, T>,
): Record<string, string> {
  const replacements: Record<string, string> = {};
  for (const [id, mark] of Object.entries(marks)) {
    if (typeof mark?.quote !== 'string' || mark.quote.trim().length === 0) continue;
    if (
      mark.kind === 'comment'
      || mark.kind === 'insert'
      || mark.kind === 'delete'
      || mark.kind === 'replace'
      || mark.kind === 'approved'
      || mark.kind === 'flagged'
    ) {
      replacements[id] = mark.quote;
    }
  }
  return replacements;
}

/**
 * Build a mapping from stripped-text indices back to original-text indices.
 * Returns an array where strippedToOriginal[i] is the index in the original
 * string corresponding to position i in the stripped string.
 */
export function buildStrippedIndexMap(markdown: string): { stripped: string; map: number[] } {
  const spanTagRegex = /<\/?span\b[^>]*>/gi;
  const agentdocStack: boolean[] = [];
  const resultChars: string[] = [];
  const indexMap: number[] = [];
  let lastIndex = 0;

  for (const match of markdown.matchAll(spanTagRegex)) {
    const matchIndex = match.index ?? -1;
    if (matchIndex < 0) continue;
    const tag = match[0];

    // Copy characters between last tag and this tag
    for (let i = lastIndex; i < matchIndex; i++) {
      resultChars.push(markdown[i]);
      indexMap.push(i);
    }
    lastIndex = matchIndex + tag.length;

    const isClosing = tag.startsWith('</');
    if (isClosing) {
      if (agentdocStack.length === 0) {
        // Non-agentdoc closing tag — keep it
        for (let i = matchIndex; i < matchIndex + tag.length; i++) {
          resultChars.push(markdown[i]);
          indexMap.push(i);
        }
        continue;
      }
      const isAgentdoc = agentdocStack.pop();
      if (!isAgentdoc) {
        for (let i = matchIndex; i < matchIndex + tag.length; i++) {
          resultChars.push(markdown[i]);
          indexMap.push(i);
        }
      }
      // Agentdoc closing tags are stripped (not added to result)
      continue;
    }

    const isAgentdoc = isAuthoredAgentdocSpan(tag);
    agentdocStack.push(isAgentdoc);
    if (!isAgentdoc) {
      for (let i = matchIndex; i < matchIndex + tag.length; i++) {
        resultChars.push(markdown[i]);
        indexMap.push(i);
      }
    }
    // Agentdoc opening tags are stripped (not added to result)
  }

  // Copy remaining characters after last tag
  for (let i = lastIndex; i < markdown.length; i++) {
    resultChars.push(markdown[i]);
    indexMap.push(i);
  }

  return { stripped: resultChars.join(''), map: indexMap };
}

export function listAuthoredAgentdocSpanBounds(markdown: string): AuthoredSpanBounds[] {
  const spanTagRegex = /<\/?span\b[^>]*>/gi;
  const stack: Array<{ authored: boolean; openStart: number; contentStart: number }> = [];
  const spans: AuthoredSpanBounds[] = [];

  for (const match of markdown.matchAll(spanTagRegex)) {
    const matchIndex = match.index ?? -1;
    if (matchIndex < 0) continue;
    const tag = match[0];

    if (tag.startsWith('</')) {
      const entry = stack.pop();
      if (!entry?.authored) continue;
      spans.push({
        openStart: entry.openStart,
        contentStart: entry.contentStart,
        contentEnd: matchIndex,
        closeEnd: matchIndex + tag.length,
      });
      continue;
    }

    stack.push({
      authored: isAuthoredAgentdocSpan(tag),
      openStart: matchIndex,
      contentStart: matchIndex + tag.length,
    });
  }

  return spans;
}

export function expandRangeToIncludeFullyWrappedAuthoredSpan(
  markdown: string,
  start: number,
  end: number,
): { start: number; end: number } {
  let nextStart = start;
  let nextEnd = end;

  for (const span of listAuthoredAgentdocSpanBounds(markdown)) {
    if (nextStart === span.contentStart && nextEnd === span.contentEnd) {
      nextStart = span.openStart;
      nextEnd = span.closeEnd;
      break;
    }
  }

  return { start: nextStart, end: nextEnd };
}

export function moveIndexPastTrailingAuthoredSpans(markdown: string, index: number): number {
  let nextIndex = index;

  while (true) {
    let advanced = false;
    let bestCloseEnd = nextIndex;

    for (const span of listAuthoredAgentdocSpanBounds(markdown)) {
      if (span.contentEnd === nextIndex && span.closeEnd > bestCloseEnd) {
        bestCloseEnd = span.closeEnd;
        advanced = true;
      }
    }

    if (!advanced) return nextIndex;
    nextIndex = bestCloseEnd;
  }
}
