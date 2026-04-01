/**
 * Selector Resolution for Batch Operations
 *
 * Resolves semantic selectors to ProseMirror document positions.
 * Works with the current document state within a transaction,
 * allowing accurate position resolution after earlier operations
 * have modified the document.
 */

import type { Node } from '@milkdown/kit/prose/model';

export interface SelectorRange {
  from: number;
  to: number;
}

/**
 * Resolve a semantic selector to a single position (offset).
 *
 * Supported selectors:
 * - "start" → 0
 * - "end" → end of document
 * - "heading:Name" → start of heading containing Name
 * - "after:## Name" → position after the heading line
 * - "before:## Name" → position before the heading line
 */
export function resolveSelector(
  doc: Node,
  selector: string,
  context?: { cursor?: number; selection?: SelectorRange | null }
): number | null {
  // Built-in selectors
  switch (selector) {
    case 'start':
      return 0;
    case 'end':
      return doc.content.size;
    case 'cursor':
      return context?.cursor ?? null;
    case 'selection':
      return context?.selection?.from ?? null;
  }

  // heading:Name - find heading containing Name, return start position
  if (selector.startsWith('heading:')) {
    const headingText = selector.slice(8).trim();
    return findHeadingPosition(doc, headingText);
  }

  // after:## Name - position after the heading line
  if (selector.startsWith('after:')) {
    const headingText = selector.slice(6).trim();
    const pos = findHeadingEndPosition(doc, headingText);
    return pos;
  }

  // before:## Name - position before the heading line
  if (selector.startsWith('before:')) {
    const headingText = selector.slice(7).trim();
    return findHeadingPosition(doc, headingText);
  }

  return null;
}

/**
 * Resolve a semantic selector to a range (from, to).
 *
 * Supported selectors:
 * - "all" → entire document
 * - "section:## Name" → from heading to next same-level heading
 * - "heading:## Name" → just the heading line
 * - "selection" → current batch selection from context
 */
export function resolveSelectorRange(
  doc: Node,
  selector: string,
  context?: { cursor?: number; selection?: SelectorRange | null }
): SelectorRange | null {
  // Built-in selectors
  if (selector === 'all') {
    return { from: 0, to: doc.content.size };
  }

  if (selector === 'selection') {
    return context?.selection ?? null;
  }

  // section:## Name - from heading to next same-level or higher heading
  if (selector.startsWith('section:')) {
    const headingText = selector.slice(8).trim();
    return findSectionRange(doc, headingText);
  }

  // heading:## Name - just the heading node
  if (selector.startsWith('heading:')) {
    const headingText = selector.slice(8).trim();
    return findHeadingRange(doc, headingText);
  }

  return null;
}

/**
 * Find the start position of a heading node containing the given text.
 */
function findHeadingPosition(doc: Node, searchText: string): number | null {
  const normalizedSearch = normalizeHeadingText(searchText);
  let foundPos: number | null = null;

  doc.descendants((node, pos) => {
    if (foundPos !== null) return false; // Already found

    if (node.type.name === 'heading') {
      const headingContent = node.textContent;
      const normalizedContent = normalizeHeadingText(headingContent);

      if (
        normalizedContent.toLowerCase().includes(normalizedSearch.toLowerCase()) ||
        headingContent.toLowerCase().includes(searchText.toLowerCase())
      ) {
        foundPos = pos;
        return false; // Stop traversal
      }
    }
    return true;
  });

  return foundPos;
}

/**
 * Find the end position of a heading node (after the heading line).
 */
function findHeadingEndPosition(doc: Node, searchText: string): number | null {
  const normalizedSearch = normalizeHeadingText(searchText);
  let foundPos: number | null = null;

  doc.descendants((node, pos) => {
    if (foundPos !== null) return false;

    if (node.type.name === 'heading') {
      const headingContent = node.textContent;
      const normalizedContent = normalizeHeadingText(headingContent);

      if (
        normalizedContent.toLowerCase().includes(normalizedSearch.toLowerCase()) ||
        headingContent.toLowerCase().includes(searchText.toLowerCase())
      ) {
        // Position after this node
        foundPos = pos + node.nodeSize;
        return false;
      }
    }
    return true;
  });

  return foundPos;
}

/**
 * Find the range of a heading node.
 */
function findHeadingRange(doc: Node, searchText: string): SelectorRange | null {
  const normalizedSearch = normalizeHeadingText(searchText);
  let result: SelectorRange | null = null;

  doc.descendants((node, pos) => {
    if (result !== null) return false;

    if (node.type.name === 'heading') {
      const headingContent = node.textContent;
      const normalizedContent = normalizeHeadingText(headingContent);

      if (
        normalizedContent.toLowerCase().includes(normalizedSearch.toLowerCase()) ||
        headingContent.toLowerCase().includes(searchText.toLowerCase())
      ) {
        result = { from: pos, to: pos + node.nodeSize };
        return false;
      }
    }
    return true;
  });

  return result;
}

/**
 * Find the range of a section (from heading to next same-level or higher heading).
 */
function findSectionRange(doc: Node, searchText: string): SelectorRange | null {
  const normalizedSearch = normalizeHeadingText(searchText);

  let sectionStart: number | null = null;
  let sectionLevel: number | null = null;
  let sectionEnd: number | null = null;

  doc.descendants((node, pos) => {
    if (sectionEnd !== null) return false; // Already found end

    if (node.type.name === 'heading') {
      const level = node.attrs.level || 1;
      const headingContent = node.textContent;
      const normalizedContent = normalizeHeadingText(headingContent);

      if (sectionStart === null) {
        // Looking for the start
        if (
          normalizedContent.toLowerCase().includes(normalizedSearch.toLowerCase()) ||
          headingContent.toLowerCase().includes(searchText.toLowerCase())
        ) {
          sectionStart = pos;
          sectionLevel = level;
        }
      } else if (sectionLevel !== null && level <= sectionLevel) {
        // Found next same-level or higher heading - section ends here
        sectionEnd = pos;
        return false;
      }
    }
    return true;
  });

  // If we found a start but reached end of document
  if (sectionStart !== null && sectionEnd === null) {
    sectionEnd = doc.content.size;
  }

  if (sectionStart !== null && sectionEnd !== null) {
    return { from: sectionStart, to: sectionEnd };
  }

  return null;
}

/**
 * Normalize heading text by removing markdown heading markers.
 */
function normalizeHeadingText(text: string): string {
  return text.replace(/^#+\s*/, '').trim();
}

/**
 * Check if content already contains a heading.
 * Used for deduplication.
 */
export function hasHeading(doc: Node, headingText: string): boolean {
  const normalizedSearch = normalizeHeadingText(headingText);
  let found = false;

  doc.descendants((node) => {
    if (found) return false;

    if (node.type.name === 'heading') {
      const content = node.textContent;
      if (normalizeHeadingText(content).toLowerCase() === normalizedSearch.toLowerCase()) {
        found = true;
        return false;
      }
    }
    return true;
  });

  return found;
}

/**
 * Extract the first heading from markdown text.
 */
export function extractHeadingFromText(text: string): string | null {
  const lines = text.split('\n');
  for (const line of lines) {
    if (line.startsWith('#')) {
      return line;
    }
  }
  return null;
}
