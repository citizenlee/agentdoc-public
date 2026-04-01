import type { AgentTool } from '../types';
import { bridgeGet, bridgePost } from '../http-bridge-client';
import {
  validateProposalBase,
  validateProposalAgainstDocument,
  normalizeProposedChange,
  type ProposalCollector,
  type ProposedChange,
  type ProposedRange,
} from '../proposals';
import {
  EDITORIAL_STYLE_GUIDE,
  EDITORIAL_STYLE_GUIDE_CHAR_COUNT,
  EDITORIAL_STYLE_GUIDE_VERSION,
} from '../skills/editorial-style-guide';

export interface BridgeMarkRange {
  from: number;
  to: number;
}

export interface BridgeMarkSummary {
  id: string;
  kind: string;
  by: string;
  quote: string;
  range: BridgeMarkRange | null;
  data: Record<string, unknown> | null;
}

interface BridgeMarkResponse {
  success?: boolean;
  marks?: unknown;
  error?: string;
}

interface BridgeMarkCreateResponse {
  success?: boolean;
  mark?: unknown;
  error?: string;
}

interface BridgeStateResponse {
  content?: unknown;
  plainText?: unknown;
  markdownContent?: unknown;
  documentPath?: unknown;
  error?: string;
}

interface BridgeSearchMatch {
  text: string;
  position: number;
  context: string;
  from: number;
  to: number;
}

interface BridgeSearchResponse {
  success?: boolean;
  count?: unknown;
  matches?: unknown;
  error?: string;
}

const MAX_SEARCH_CONTEXT_CHARS = 240;
const MAX_NO_WHITESPACE_MATCH_CHARS = 1200;

export interface HttpBridgeToolsOptions {
  agentId: string;
  actor: string;
  signal?: AbortSignal;
  mode?: 'apply' | 'propose' | 'propose-visible';
  proposalCollector?: ProposalCollector;
  runId?: string;
  focusAreaId?: string;
  focusAreaName?: string;
  provisionalMarks?: boolean;
  singleWriter?: boolean;
  documentContent?: string;
  onToolEvent?: (event: { type: 'candidates' | 'proposals'; count: number; focusAreaId?: string }) => void;
}

const SUGGESTION_ENDPOINTS = {
  insert: '/marks/suggest-insert',
  delete: '/marks/suggest-delete',
  replace: '/marks/suggest-replace',
} as const;

const SUGGESTION_KINDS = new Set<string>(['insert', 'delete', 'replace']);
const REGEX_NO_MATCH_BUDGET_MAX = 3;
const REGEX_SEARCH_CALLS_WITHOUT_NEW_MATCHES_MAX = 8;
const STYLE_REVIEW_SEARCH_CALLS_MAX_DEFAULT = 12;
const STYLE_REVIEW_READ_DOCUMENT_CHAR_CAP = 60_000;

// Keep per-focus caps modest and aligned with each focus area's listed searches.
// The goal is to limit search thrash without blocking recall when matches exist.
const STYLE_REVIEW_SEARCH_CALLS_MAX_BY_FOCUS: Record<string, number> = {
  abbreviations: 4,
  bylines: 4,
  capitalization: 4,
  hyphens: 3,
  headlines: 4,
  'commas-that-which': 3,
  'word-bank': 5,
  usage: 6,
};

const STYLE_REVIEW_SCOPE_TRIGGERS: Record<string, { patterns: RegExp[]; labels: string[] }> = {
  abbreviations: {
    patterns: [/\b[A-Z]{2,}\b/],
    labels: ['uppercase acronym (e.g., USAAF)'],
  },
  headlines: {
    patterns: [/^Hed:/i, /^Dek:/i],
    labels: ['Hed:', 'Dek:', 'a recent search match'],
  },
  capitalization: {
    patterns: [
      /:\s+[A-Z]/,
      /\b(Website|Internet|Online|Email|Web3)\b/i,
      /\b(Director|Manager|Founder|Editor|Senator|Representative|President|Governor|Mayor|Professor)\b/,
    ],
    labels: ['colon + capital letter', 'Website/Internet/Online/Email/Web3', 'title words (e.g., Director, Senator)'],
  },
  bylines: {
    patterns: [
      /^By\s+/i,
      /&/,
      /\b(general partner|guest author|originally published|newsletter)\b/i,
    ],
    labels: ['By ...', '& in byline', 'bio cue terms (e.g., general partner, guest author)'],
  },
  usage: {
    patterns: [/\b(less|over|under|actually|very|just)\b/i],
    labels: ['usage terms: less, over, under, actually, very, just'],
  },
  'word-bank': {
    patterns: [
      /\bstart-up\b/i,
      /\bco-founder\b/i,
      /\be-mail\b/i,
      /\blog-in\b/i,
      /\bsign-up\b/i,
    ],
    labels: ['start-up', 'co-founder', 'e-mail', 'log-in', 'sign-up'],
  },
};

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new Error('Review cancelled');
  }
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function handleToolError(error: unknown, signal?: AbortSignal): { success: false; error: string } {
  if (signal?.aborted) {
    throw error instanceof Error ? error : new Error(String(error));
  }
  return { success: false, error: toErrorMessage(error) };
}

function headlinesStandaloneCandidate(quote: string, documentContent?: string | null): boolean {
  if (!documentContent) return false;
  if (quote.includes('\n')) return false;
  const needle = quote.trim();
  if (!needle) return false;

  const lines = documentContent.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i].trim() !== needle) continue;
    const prevBlank = i === 0 || lines[i - 1].trim() === '';
    const nextBlank = i === lines.length - 1 || lines[i + 1].trim() === '';
    if (prevBlank && nextBlank) {
      return true;
    }
  }
  return false;
}

function extractHeadingText(markdown: string | undefined): string | null {
  if (!markdown) return null;
  const trimmed = markdown.trim();
  const match = /^(#{1,6})\s+(.+)$/.exec(trimmed);
  if (!match) return null;
  const text = match[2]?.trim();
  return text && text.length > 0 ? text : null;
}

function sanitizeHeadlinesQuote(
  quote: string,
  content: string | undefined,
  documentContent?: string | null
): { quote: string; adjusted: boolean; reason?: string } {
  let nextQuote = quote.trim();
  let adjusted = false;
  let reason: string | undefined;

  // If the quote spans multiple lines, prefer the first line.
  if (nextQuote.includes('\n')) {
    const labelMatches = nextQuote.match(/(^|[\s])(Hed:|Dek:)/gi);
    const hasMultipleLabels = (labelMatches?.length ?? 0) > 1;
    if (!hasMultipleLabels) {
      const firstLine = nextQuote.split('\n')[0]?.trim();
      if (firstLine && firstLine !== nextQuote) {
        nextQuote = firstLine;
        adjusted = true;
        reason = 'headlines_quote_first_line';
      }
    }
  }

  // If we have heading markdown content, try to anchor to the heading text.
  const headingText = extractHeadingText(content);
  if (headingText && documentContent) {
    if (headlinesStandaloneCandidate(headingText, documentContent) && headingText !== nextQuote) {
      nextQuote = headingText;
      adjusted = true;
      reason = 'headlines_quote_heading_text';
    }
  }

  return { quote: nextQuote, adjusted, reason };
}

function enforceStyleReviewScope(
  quote: string,
  focusAreaId?: string,
  recentSearchMatchTexts?: Set<string>,
  documentContent?: string | null
): { error?: string; warning?: string } | null {
  if (!focusAreaId) return null;
  if (focusAreaId === 'headlines') {
    const hasLabel = /(^|\s)(Hed:|Dek:)/i.test(quote);
    if (hasLabel) return null;

    if (recentSearchMatchTexts && recentSearchMatchTexts.size > 0) {
      for (const text of recentSearchMatchTexts) {
        if (!text) continue;
        if (quote.includes(text) || text.includes(quote)) {
          return null;
        }
      }
    }

    if (headlinesStandaloneCandidate(quote, documentContent)) {
      return null;
    }

    // Do not block, but surface that this was not anchored to a strong
    // headline candidate signal.
    return {
      warning: 'Headlines scope: quote not anchored to Hed:/Dek:, recent search match, or standalone blank-line-surrounded line.',
    };
  }
  const config = STYLE_REVIEW_SCOPE_TRIGGERS[focusAreaId];
  if (!config) return null;
  if (config.patterns.some((pattern) => pattern.test(quote))) {
    return null;
  }
  return {
    error: `Focus scope enforcement (${focusAreaId}): quote must include one of: ${config.labels.join(', ')}.`,
  };
}

interface StructuralCandidateSignals {
  blankLineBefore: boolean;
  blankLineAfter: boolean;
  alreadyHeading: boolean;
  hedDekLabel: 'hed' | 'dek' | 'hed-dek' | null;
  headingLike: boolean;
  lineIndex: number;
  listType?: 'bullet' | 'numbered' | null;
  listMarker?: string | null;
  listIndex?: number | null;
}

interface StructuralCandidate {
  candidateId: string;
  text: string;
  range: ProposedRange | null;
  signals: StructuralCandidateSignals;
}

const STRUCTURAL_FOCUS_AREAS = new Set<string>([
  'headlines',
  'lists',
  'captions',
  'hed-dek',
]);

const HEADING_MARKDOWN_RE = /^\s*#{1,6}\s+/;
const LIST_MARKDOWN_RE = /^\s*(?:[-*+]\s+|\d+\.\s+)/;
const STRUCTURAL_MARKDOWN_RE = /^\s*(?:#{1,6}\s+|[-*+]\s+|\d+\.\s+|>\s+|```|~~~|[-*_]{3,}\s*$)/m;
const HED_LABEL_RE = /^\s*Hed:\s*/i;
const DEK_LABEL_RE = /^\s*Dek:\s*/i;

function isStructuralFocusArea(focusAreaId?: string): boolean {
  return Boolean(focusAreaId && STRUCTURAL_FOCUS_AREAS.has(focusAreaId));
}

function extractHedDekPair(text: string): { hed: string | null; dek: string | null } {
  const lines = text.split(/\n/);
  let hed: string | null = null;
  let dek: string | null = null;
  for (const line of lines) {
    if (!hed && HED_LABEL_RE.test(line)) {
      const value = line.replace(HED_LABEL_RE, '').trim();
      hed = value.length > 0 ? value : null;
      continue;
    }
    if (!dek && DEK_LABEL_RE.test(line)) {
      const value = line.replace(DEK_LABEL_RE, '').trim();
      dek = value.length > 0 ? value : null;
    }
  }
  return { hed, dek };
}

function isStructuralMarkdown(content: string | undefined): boolean {
  if (!content) return false;
  const trimmed = content.trim();
  if (!trimmed) return false;
  return STRUCTURAL_MARKDOWN_RE.test(trimmed);
}

function normalizeRange(range: unknown): ProposedRange | null {
  if (!range || typeof range !== 'object') return null;
  const fromValue = (range as { from?: unknown }).from;
  const toValue = (range as { to?: unknown }).to;
  const from = Number(fromValue);
  const to = Number(toValue);
  if (!Number.isFinite(from) || !Number.isFinite(to)) return null;
  const fromInt = Math.max(0, Math.floor(from));
  const toInt = Math.max(fromInt, Math.floor(to));
  return { from: fromInt, to: toInt };
}

function hashStringFNV1aLocal(value: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(36);
}

function buildCandidateId(focusAreaId: string, range: ProposedRange | null, text: string): string {
  const rangePart = range ? `${range.from}-${range.to}` : 'no-range';
  const hashPart = hashStringFNV1aLocal(text.trim().slice(0, 200));
  return `cand-${focusAreaId}-${rangePart}-${hashPart}`;
}

function buildLineRecords(document: string): Array<{
  text: string;
  trimmed: string;
  from: number;
  to: number;
  blank: boolean;
}> {
  const records: Array<{
    text: string;
    trimmed: string;
    from: number;
    to: number;
    blank: boolean;
  }> = [];
  let offset = 0;
  const lines = document.split(/\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const text = lines[i] ?? '';
    const from = offset;
    const to = from + text.length;
    const trimmed = text.trim();
    const blank = trimmed.length === 0;
    records.push({ text, trimmed, from, to, blank });
    offset = to + 1;
  }
  return records;
}

function alignPlainRecordsToMarkdown(
  markdownRecords: Array<{ text: string; trimmed: string; from: number; to: number; blank: boolean }>,
  plainRecords: Array<{ text: string; trimmed: string; from: number; to: number; blank: boolean }>,
  plainDocumentLength: number
): Array<{ text: string; trimmed: string; from: number; to: number; blank: boolean }> {
  // /state.plainText collapses blank lines, so naive line-index alignment
  // drifts after the first blank line. Align by walking markdown lines
  // and only consuming a plain line for non-blank markdown lines.
  const aligned: Array<{ text: string; trimmed: string; from: number; to: number; blank: boolean }> = [];
  let plainIndex = 0;

  for (let i = 0; i < markdownRecords.length; i += 1) {
    const markdownRecord = markdownRecords[i];
    if (!markdownRecord) continue;

    if (markdownRecord.blank) {
      const fallbackFrom = plainRecords[plainIndex]?.from ?? plainDocumentLength;
      aligned.push({
        text: '',
        trimmed: '',
        from: fallbackFrom,
        to: fallbackFrom,
        blank: true,
      });
      continue;
    }

    const plainRecord = plainRecords[plainIndex];
    if (plainRecord) {
      aligned.push(plainRecord);
      plainIndex += 1;
      continue;
    }

    const fallbackFrom = plainDocumentLength;
    aligned.push({
      text: markdownRecord.text,
      trimmed: markdownRecord.trimmed,
      from: fallbackFrom,
      to: fallbackFrom,
      blank: false,
    });
  }

  return aligned;
}

function isHeadingLikeStandaloneLine(trimmed: string): boolean {
  if (!trimmed) return false;
  if (trimmed.length < 8 || trimmed.length > 140) return false;
  if (HEADING_MARKDOWN_RE.test(trimmed)) return false;
  if (HED_LABEL_RE.test(trimmed) || DEK_LABEL_RE.test(trimmed)) return false;
  if (LIST_MARKDOWN_RE.test(trimmed)) return false;
  if (/^[-*_]{3,}\s*$/.test(trimmed)) return false;
  const wordCount = trimmed.split(/\s+/).filter(Boolean).length;
  if (wordCount > 16) return false;
  // Headings rarely end with a period or exclamation point; paragraphs often do.
  if (/[.!]\s*$/.test(trimmed) && wordCount > 8) return false;
  // Avoid obvious paragraph lines.
  if (/\.\s+[A-Z]/.test(trimmed)) return false;
  return true;
}

function computeHeadlinesCandidates(markdownDocument: string, plainDocument: string, focusAreaId: string): StructuralCandidate[] {
  const markdownRecords = buildLineRecords(markdownDocument);
  const plainLineRecords = buildLineRecords(plainDocument);
  const plainRecords = alignPlainRecordsToMarkdown(markdownRecords, plainLineRecords, plainDocument.length);
  const lineCount = markdownRecords.length;
  const candidates: StructuralCandidate[] = [];
  const seenIds = new Set<string>();

  const findLabelsInLine = (text: string): Array<{ type: 'hed' | 'dek'; startIndex: number }> => {
    const labels: Array<{ type: 'hed' | 'dek'; startIndex: number }> = [];
    const labelRe = /(^|[\s])((Hed|Dek):)/gi;
    let match: RegExpExecArray | null;
    while ((match = labelRe.exec(text)) !== null) {
      const leading = match[1] ?? '';
      const labelStart = match.index + leading.length;
      const labelType = (match[3] ?? '').toLowerCase() === 'dek' ? 'dek' : 'hed';
      labels.push({ type: labelType, startIndex: labelStart });
    }
    return labels;
  };

  const isPlainBoundaryLine = (record: { text: string; trimmed: string; blank: boolean }): boolean => {
    if (!record || record.blank) return true;
    const trimmed = record.trimmed;
    if (!trimmed) return true;
    if (HEADING_MARKDOWN_RE.test(trimmed)) return true;
    if (LIST_MARKDOWN_RE.test(trimmed)) return true;
    if (/^[-*_]{3,}\s*$/.test(trimmed)) return true;
    // Guardrail: do not let Hed/Dek spans swallow obvious paragraph lines.
    if (trimmed.length > 180) return true;
    if (/\.\s+[A-Z]/.test(trimmed)) return true;
    return false;
  };

  const nextOffsetAfter = (sortedOffsets: number[], offset: number): number | null => {
    for (let i = 0; i < sortedOffsets.length; i += 1) {
      const candidate = sortedOffsets[i];
      if (candidate != null && candidate > offset) return candidate;
    }
    return null;
  };

  const trimRangeEnd = (from: number, to: number): number => {
    let end = Math.max(from, Math.min(to, plainDocument.length));
    while (end > from) {
      const ch = plainDocument[end - 1] ?? '';
      if (!/\s/.test(ch)) break;
      end -= 1;
    }
    return end;
  };

  const labelOccurrences: Array<{ type: 'hed' | 'dek'; start: number; lineIndex: number }> = [];
  const boundaryOffsets: number[] = [];
  const lineHasLabel: boolean[] = new Array(lineCount).fill(false);

  for (let i = 0; i < lineCount; i += 1) {
    const plainRecord = plainRecords[i];
    if (!plainRecord) continue;
    const labels = findLabelsInLine(plainRecord.text);
    if (labels.length > 0) {
      lineHasLabel[i] = true;
      for (const label of labels) {
        const absoluteStart = plainRecord.from + label.startIndex;
        labelOccurrences.push({ type: label.type, start: absoluteStart, lineIndex: i });
      }
    }
  }

  // Boundary offsets are the start of lines that should terminate Hed/Dek spans.
  // Do not mark label lines as boundaries; labels themselves are handled separately.
  for (let i = 0; i < lineCount; i += 1) {
    const plainRecord = plainRecords[i];
    if (!plainRecord) continue;
    if (lineHasLabel[i]) continue;
    if (isPlainBoundaryLine(plainRecord)) {
      boundaryOffsets.push(plainRecord.from);
    }
  }
  boundaryOffsets.push(plainDocument.length);

  labelOccurrences.sort((a, b) => a.start - b.start);
  boundaryOffsets.sort((a, b) => a - b);

  // 1) Hed/Dek label candidates (grouped label spans, range-safe).
  // Group consecutive label lines together so Hed+Dek pairs become a single
  // block-aligned candidate. This avoids structural safety rejections for
  // partial paragraph ranges when Hed/Dek live in the same textblock.
  const labelGroups: Array<{ startIndex: number; endIndex: number }> = [];
  if (labelOccurrences.length > 0) {
    let groupStartIndex = 0;
    for (let i = 1; i < labelOccurrences.length; i += 1) {
      const prev = labelOccurrences[i - 1];
      const curr = labelOccurrences[i];
      if (!prev || !curr) continue;
      let split = false;
      for (let line = prev.lineIndex + 1; line <= curr.lineIndex; line += 1) {
        const markdownRecord = markdownRecords[line];
        if (!markdownRecord) continue;
        if (markdownRecord.blank || !lineHasLabel[line]) {
          split = true;
          break;
        }
      }
      if (split) {
        labelGroups.push({ startIndex: groupStartIndex, endIndex: i - 1 });
        groupStartIndex = i;
      }
    }
    labelGroups.push({ startIndex: groupStartIndex, endIndex: labelOccurrences.length - 1 });
  }

  const nextNonLabelLineStart = (lineIndex: number): number => {
    for (let i = lineIndex + 1; i < lineCount; i += 1) {
      const markdownRecord = markdownRecords[i];
      const plainRecord = plainRecords[i];
      if (!markdownRecord || !plainRecord) continue;
      if (markdownRecord.blank) continue;
      if (lineHasLabel[i]) continue;
      return plainRecord.from;
    }
    return plainDocument.length;
  };

  for (const group of labelGroups) {
    const firstOccurrence = labelOccurrences[group.startIndex];
    const lastOccurrence = labelOccurrences[group.endIndex];
    if (!firstOccurrence || !lastOccurrence) continue;

    const startLineIndex = firstOccurrence.lineIndex;
    const endLineIndex = lastOccurrence.lineIndex;
    const groupStart = firstOccurrence.start;
    const nextBoundaryStart = nextOffsetAfter(boundaryOffsets, groupStart) ?? plainDocument.length;
    const boundaryFromNonLabel = nextNonLabelLineStart(endLineIndex);
    const rawEnd = Math.min(nextBoundaryStart, boundaryFromNonLabel, plainDocument.length);
    const end = trimRangeEnd(groupStart, rawEnd);
    if (end <= groupStart) continue;

    const rawSlice = plainDocument.slice(groupStart, end);
    const stripped = rawSlice.replace(/^\s*(Hed:|Dek:)\s*/gim, '').trim();
    if (!stripped) continue;

    const labelTypes = new Set<'hed' | 'dek'>();
    for (let i = group.startIndex; i <= group.endIndex; i += 1) {
      const occurrence = labelOccurrences[i];
      if (occurrence) labelTypes.add(occurrence.type);
    }
    const hedDekLabel: StructuralCandidateSignals['hedDekLabel'] = (
      labelTypes.has('hed') && labelTypes.has('dek')
        ? 'hed-dek'
        : labelTypes.has('hed')
          ? 'hed'
          : labelTypes.has('dek')
            ? 'dek'
            : null
    );

    const prevBlank = startLineIndex === 0 ? true : (markdownRecords[startLineIndex - 1]?.blank ?? true);
    const nextBlank = endLineIndex === lineCount - 1 ? true : (markdownRecords[endLineIndex + 1]?.blank ?? true);
    const plainPrevBlank = startLineIndex === 0 ? true : (plainRecords[startLineIndex - 1]?.blank ?? true);
    const plainNextBlank = endLineIndex === lineCount - 1 ? true : (plainRecords[endLineIndex + 1]?.blank ?? true);
    const markdownTrimmed = markdownRecords[startLineIndex]?.trimmed ?? '';
    const plainTrimmed = plainRecords[startLineIndex]?.trimmed ?? '';
    const alreadyHeading = HEADING_MARKDOWN_RE.test(markdownTrimmed) || HEADING_MARKDOWN_RE.test(plainTrimmed);
    const headingLike = isHeadingLikeStandaloneLine(stripped.split('\n')[0] ?? stripped);

    const range: ProposedRange = { from: groupStart, to: end };
    const candidateText = rawSlice.trim();
    const candidateId = buildCandidateId(focusAreaId, range, candidateText);
    if (seenIds.has(candidateId)) continue;
    seenIds.add(candidateId);

    candidates.push({
      candidateId,
      text: candidateText,
      range,
      signals: {
        blankLineBefore: prevBlank && plainPrevBlank,
        blankLineAfter: nextBlank && plainNextBlank,
        alreadyHeading,
        hedDekLabel,
        headingLike,
        lineIndex: startLineIndex,
      },
    });
  }

  // 2) Standalone heading-like lines (non-label structural candidates).
  for (let i = 0; i < lineCount; i += 1) {
    const startIndex = i;
    const markdownRecord = markdownRecords[i];
    const plainRecord = plainRecords[i];
    if (!markdownRecord || !plainRecord) continue;

    const markdownTrimmed = markdownRecord.trimmed;
    const plainTrimmed = plainRecord.trimmed;
    if (!markdownTrimmed && !plainTrimmed) continue;

    const prevBlank = i === 0 ? true : (markdownRecords[i - 1]?.blank ?? true);
    const nextBlank = i === lineCount - 1 ? true : (markdownRecords[i + 1]?.blank ?? true);
    const plainPrevBlank = i === 0 ? true : (plainRecords[i - 1]?.blank ?? true);
    const plainNextBlank = i === lineCount - 1 ? true : (plainRecords[i + 1]?.blank ?? true);
    const alreadyHeading = HEADING_MARKDOWN_RE.test(markdownTrimmed) || HEADING_MARKDOWN_RE.test(plainTrimmed);
    const hedDekLabelFromPlain = HED_LABEL_RE.test(plainTrimmed)
      ? 'hed'
      : (DEK_LABEL_RE.test(plainTrimmed) ? 'dek' : null);
    const hedDekLabelFromMarkdown = HED_LABEL_RE.test(markdownTrimmed)
      ? 'hed'
      : (DEK_LABEL_RE.test(markdownTrimmed) ? 'dek' : null);
    const hedDekLabel = hedDekLabelFromPlain ?? hedDekLabelFromMarkdown;
    const headingLike = isHeadingLikeStandaloneLine(plainTrimmed || markdownTrimmed);
    const standaloneCandidate = prevBlank && nextBlank && plainPrevBlank && plainNextBlank && headingLike && !alreadyHeading && !hedDekLabel;

    if (lineHasLabel[i]) {
      continue;
    }
    if (!standaloneCandidate) {
      continue;
    }

    let candidateText = '';
    let range: ProposedRange | null = null;
    const plainTrimmedLocal = plainRecord.trimmed;
    candidateText = plainTrimmedLocal.length > 0
      ? plainTrimmedLocal
      : markdownTrimmed.replace(HEADING_MARKDOWN_RE, '').trim();
    range = plainTrimmedLocal.length > 0
      ? { from: plainRecord.from, to: plainRecord.to }
      : null;

    if (!candidateText) continue;
    const candidateId = buildCandidateId(focusAreaId, range, candidateText);
    if (seenIds.has(candidateId)) continue;
    seenIds.add(candidateId);

    candidates.push({
      candidateId,
      text: candidateText,
      range,
      signals: {
        blankLineBefore: prevBlank,
        blankLineAfter: nextBlank,
        alreadyHeading,
        hedDekLabel: null,
        headingLike,
        lineIndex: startIndex,
      },
    });
  }

  return candidates;
}

function computeListsCandidates(markdownDocument: string, plainDocument: string, focusAreaId: string): StructuralCandidate[] {
  const markdownRecords = buildLineRecords(markdownDocument);
  const plainLineRecords = buildLineRecords(plainDocument);
  const plainRecords = alignPlainRecordsToMarkdown(markdownRecords, plainLineRecords, plainDocument.length);
  const candidates: StructuralCandidate[] = [];
  const seenIds = new Set<string>();

  const listMarkerRe = /^\s*(?:([-*+])\s+|(\d+)\.\s+)/;
  const trimPlainRange = (from: number, to: number): ProposedRange | null => {
    let start = Math.max(0, Math.min(from, plainDocument.length));
    let end = Math.max(start, Math.min(to, plainDocument.length));
    while (start < end && /\s/.test(plainDocument[start] ?? '')) start += 1;
    while (end > start && /\s/.test(plainDocument[end - 1] ?? '')) end -= 1;
    return end > start ? { from: start, to: end } : null;
  };

  for (let i = 0; i < markdownRecords.length; i += 1) {
    const markdownRecord = markdownRecords[i];
    const plainRecord = plainRecords[i];
    if (!markdownRecord || !plainRecord) continue;

    const markerMatch = listMarkerRe.exec(markdownRecord.text);
    if (!markerMatch) continue;

    const bulletMarker = markerMatch[1] ?? '';
    const numberMarker = markerMatch[2] ?? '';
    const listType: StructuralCandidateSignals['listType'] = bulletMarker ? 'bullet' : 'numbered';
    const listMarker = bulletMarker ? bulletMarker : (numberMarker ? `${numberMarker}.` : null);
    const listIndex = numberMarker ? Number.parseInt(numberMarker, 10) : null;
    const candidateText = plainRecord.trimmed || markdownRecord.text.replace(listMarkerRe, '').trim();
    if (!candidateText) continue;

    const prevBlank = i === 0 ? true : (markdownRecords[i - 1]?.blank ?? true);
    const nextBlank = i === markdownRecords.length - 1 ? true : (markdownRecords[i + 1]?.blank ?? true);
    const plainPrevBlank = i === 0 ? true : (plainRecords[i - 1]?.blank ?? true);
    const plainNextBlank = i === markdownRecords.length - 1 ? true : (plainRecords[i + 1]?.blank ?? true);
    const range = trimPlainRange(plainRecord.from, plainRecord.to) ?? { from: plainRecord.from, to: plainRecord.to };
    const candidateId = buildCandidateId(focusAreaId, range, candidateText);
    if (seenIds.has(candidateId)) continue;
    seenIds.add(candidateId);

    candidates.push({
      candidateId,
      text: candidateText,
      range,
      signals: {
        blankLineBefore: prevBlank && plainPrevBlank,
        blankLineAfter: nextBlank && plainNextBlank,
        alreadyHeading: false,
        hedDekLabel: null,
        headingLike: false,
        lineIndex: i,
        listType,
        listMarker,
        listIndex,
      },
    });
  }

  return candidates;
}

function computeStructuralCandidates(markdownDocument: string, plainDocument: string, focusAreaId?: string): StructuralCandidate[] {
  if (!focusAreaId) return [];
  if (focusAreaId === 'headlines') {
    return computeHeadlinesCandidates(markdownDocument, plainDocument, focusAreaId);
  }
  if (focusAreaId === 'lists') {
    return computeListsCandidates(markdownDocument, plainDocument, focusAreaId);
  }
  return [];
}

function summarizeMarks(marks: unknown): BridgeMarkSummary[] {
  if (!Array.isArray(marks)) return [];

  const summaries: BridgeMarkSummary[] = [];
  for (const mark of marks) {
    if (!mark || typeof mark !== 'object') continue;
    const id = (mark as { id?: unknown }).id;
    const kind = (mark as { kind?: unknown }).kind;
    const by = (mark as { by?: unknown }).by;
    const quote = (mark as { quote?: unknown }).quote;
    if (typeof id !== 'string' || typeof kind !== 'string' || typeof by !== 'string' || typeof quote !== 'string') {
      continue;
    }

    const rangeValue = (mark as { range?: unknown }).range;
    const range = rangeValue && typeof rangeValue === 'object'
      ? {
          from: Number((rangeValue as { from?: unknown }).from ?? NaN),
          to: Number((rangeValue as { to?: unknown }).to ?? NaN),
        }
      : null;
    const normalizedRange = range && Number.isFinite(range.from) && Number.isFinite(range.to)
      ? { from: range.from, to: range.to }
      : null;

    const dataValue = (mark as { data?: unknown }).data;
    const normalizedData = dataValue && typeof dataValue === 'object'
      ? (dataValue as Record<string, unknown>)
      : null;

    summaries.push({
      id,
      kind,
      by,
      quote,
      range: normalizedRange,
      data: normalizedData,
    });
  }

  return summaries;
}

function truncateSearchContext(context: string, text: string): string {
  if (context.length <= MAX_SEARCH_CONTEXT_CHARS) {
    return context;
  }
  const snippet = text.slice(0, 80);
  const idx = snippet ? context.indexOf(snippet) : -1;
  if (idx >= 0) {
    const start = Math.max(0, idx - Math.floor((MAX_SEARCH_CONTEXT_CHARS - snippet.length) / 2));
    return context.slice(start, start + MAX_SEARCH_CONTEXT_CHARS);
  }
  return context.slice(0, MAX_SEARCH_CONTEXT_CHARS);
}

function summarizeSearchMatches(matches: unknown): BridgeSearchMatch[] {
  if (!Array.isArray(matches)) return [];

  const results: BridgeSearchMatch[] = [];
  for (const match of matches) {
    if (!match || typeof match !== 'object') continue;
    const text = (match as { text?: unknown }).text;
    const position = (match as { position?: unknown }).position;
    const context = (match as { context?: unknown }).context;
    const from = (match as { from?: unknown }).from ?? position;
    const to = (match as { to?: unknown }).to;

    if (typeof text !== 'string' || typeof context !== 'string') continue;
    if (typeof position !== 'number' || !Number.isFinite(position)) continue;

    if (text.length > MAX_NO_WHITESPACE_MATCH_CHARS && !/\s/.test(text)) {
      // Extremely long, no-whitespace matches are typically data URIs or similar noise.
      continue;
    }

    const fromNumber = typeof from === 'number' && Number.isFinite(from) ? from : position;
    const toNumber = typeof to === 'number' && Number.isFinite(to) ? to : fromNumber + text.length;
    const normalizedContext = truncateSearchContext(context, text);

    results.push({
      text,
      position,
      context: normalizedContext,
      from: fromNumber,
      to: toNumber,
    });
  }

  return results;
}

function buildRegexMatchKey(match: BridgeSearchMatch): string {
  return `${match.from}:${match.to}:${match.text}`;
}

function extractMarkId(response: BridgeMarkCreateResponse): string | undefined {
  if (typeof response.markId === 'string' && response.markId.length > 0) {
    return response.markId;
  }
  const mark = response.mark;
  if (!mark || typeof mark !== 'object') return undefined;
  const id = (mark as { id?: unknown }).id;
  return typeof id === 'string' && id.length > 0 ? id : undefined;
}

function buildOrchestrationFields(
  base: {
    agentId: string;
    runId?: string;
    focusAreaId?: string;
    focusAreaName?: string;
  },
  overrides?: {
    proposalId?: string;
    provisional?: boolean;
    orchestrator?: boolean;
  }
): Record<string, unknown> {
  const fields: Record<string, unknown> = {
    agentId: base.agentId,
  };

  if (typeof base.runId === 'string' && base.runId.trim().length > 0) {
    fields.runId = base.runId.trim();
  }
  if (typeof base.focusAreaId === 'string' && base.focusAreaId.trim().length > 0) {
    fields.focusAreaId = base.focusAreaId.trim();
  }
  if (typeof base.focusAreaName === 'string' && base.focusAreaName.trim().length > 0) {
    fields.focusAreaName = base.focusAreaName.trim();
  }

  if (overrides) {
    if (typeof overrides.proposalId === 'string' && overrides.proposalId.trim().length > 0) {
      fields.proposalId = overrides.proposalId.trim();
    }
    if (typeof overrides.provisional === 'boolean') {
      fields.provisional = overrides.provisional;
    }
    if (typeof overrides.orchestrator === 'boolean') {
      fields.orchestrator = overrides.orchestrator;
    }
  }

  return fields;
}

export function isSuggestionMark(mark: BridgeMarkSummary): boolean {
  return SUGGESTION_KINDS.has(mark.kind);
}

export function getSuggestionMarkIds(marks: BridgeMarkSummary[], actor: string): Set<string> {
  const ids = new Set<string>();
  for (const mark of marks) {
    if (mark.by !== actor) continue;
    if (!isSuggestionMark(mark)) continue;
    ids.add(mark.id);
  }
  return ids;
}

export async function fetchMarks(options: HttpBridgeToolsOptions): Promise<BridgeMarkSummary[]> {
  throwIfAborted(options.signal);
  const response = await bridgeGet<BridgeMarkResponse>('/marks', {
    agentId: options.agentId,
    signal: options.signal,
  });

  if (response.success === false) {
    throw new Error(response.error ?? 'Failed to fetch marks');
  }

  return summarizeMarks(response.marks);
}

export function getHttpBridgeTools(options: HttpBridgeToolsOptions): AgentTool[] {
  const {
    agentId,
    actor,
    signal,
    mode = 'apply',
    proposalCollector,
    runId,
    focusAreaId,
    focusAreaName,
    provisionalMarks,
    singleWriter,
    documentContent,
    onToolEvent,
  } = options;
  const isStyleReviewAgent = agentId.includes('style-review')
    || actor.includes('style-review')
    || agentId.includes('demo-day')
    || actor.includes('demo-day');
  const resolvedFocusAreaId = typeof focusAreaId === 'string' ? focusAreaId.trim() : '';
  const baseFocusAreaId = (() => {
    if (!resolvedFocusAreaId) return undefined;
    const runPrefix = typeof runId === 'string' && runId.trim().length > 0 ? `${runId}-` : '';
    if (runPrefix && resolvedFocusAreaId.startsWith(runPrefix)) {
      const stripped = resolvedFocusAreaId.slice(runPrefix.length).trim();
      return stripped.length > 0 ? stripped : resolvedFocusAreaId;
    }
    return resolvedFocusAreaId;
  })();
  const styleReviewSearchCallsMax = isStyleReviewAgent
    ? (baseFocusAreaId ? (STYLE_REVIEW_SEARCH_CALLS_MAX_BY_FOCUS[baseFocusAreaId] ?? STYLE_REVIEW_SEARCH_CALLS_MAX_DEFAULT) : STYLE_REVIEW_SEARCH_CALLS_MAX_DEFAULT)
    : null;
  const hasRunId = typeof runId === 'string' && runId.trim().length > 0;
  const singleWriterEnabled = singleWriter === true;
  const wantsVisibleProvisionalMarks = !singleWriterEnabled && (mode === 'propose-visible' || provisionalMarks === true);
  const canCreateProvisionalMarks = wantsVisibleProvisionalMarks && hasRunId;
  const orchestrationBase = { agentId, runId, focusAreaId, focusAreaName };
  const applyOrchestrationFields = hasRunId
    ? buildOrchestrationFields(orchestrationBase, { provisional: false, orchestrator: true })
    : {};
  let cachedDocumentContent: string | null = null;
  let cachedPlainDocumentContent: string | null = typeof documentContent === 'string' ? documentContent : null;
  let hasFetchedState = false;
  let cachedDocumentTruncated = false;
  const structuralCandidateCache = new Map<string, StructuralCandidate[]>();
  let headlinesCandidatesListed = false;
  let headlinesCandidateCount = 0;
  let regexNoMatchBudgetRemaining = REGEX_NO_MATCH_BUDGET_MAX;
  let regexNoMatchBudgetExhausted = false;
  let regexSearchCallsSinceNewMatches = 0;
  let searchCallsUsed = 0;
  const seenRegexMatchKeys = new Set<string>();
  const recentSearchMatchTexts = new Set<string>();

  const listStructuralCandidates = async (requestedFocusAreaId?: string): Promise<{
    focusAreaId: string | null;
    candidates: StructuralCandidate[];
    cached: boolean;
  }> => {
    const targetFocusAreaId = (requestedFocusAreaId ?? baseFocusAreaId ?? '').trim();
    if (!targetFocusAreaId) {
      return { focusAreaId: null, candidates: [], cached: false };
    }

    const cached = structuralCandidateCache.get(targetFocusAreaId);
    if (cached) {
      return { focusAreaId: targetFocusAreaId, candidates: cached, cached: true };
    }

    const snapshot = await ensureDocumentSnapshot();
    if (!snapshot) {
      return { focusAreaId: targetFocusAreaId, candidates: [], cached: false };
    }

    const candidates = computeStructuralCandidates(snapshot.markdown, snapshot.plain, targetFocusAreaId);
    structuralCandidateCache.set(targetFocusAreaId, candidates);
    onToolEvent?.({ type: 'candidates', count: candidates.length, focusAreaId: targetFocusAreaId });
    if (targetFocusAreaId === 'headlines') {
      headlinesCandidatesListed = true;
      headlinesCandidateCount = candidates.length;
    }

    return { focusAreaId: targetFocusAreaId, candidates, cached: false };
  };

  function resetRegexNoMatchBudget(reason: string): string {
    regexNoMatchBudgetRemaining = REGEX_NO_MATCH_BUDGET_MAX;
    regexNoMatchBudgetExhausted = false;
    regexSearchCallsSinceNewMatches = 0;
    return reason;
  }

  function isRegexBudgetExhausted(): {
    exhausted: boolean;
    noProgressBudgetExhausted: boolean;
    searchCallBudgetExhausted: boolean;
  } {
    const noProgressBudgetExhausted = regexSearchCallsSinceNewMatches >= REGEX_SEARCH_CALLS_WITHOUT_NEW_MATCHES_MAX;
    const searchCallBudgetExhausted = styleReviewSearchCallsMax !== null && searchCallsUsed >= styleReviewSearchCallsMax;
    return {
      exhausted: regexNoMatchBudgetExhausted || noProgressBudgetExhausted || searchCallBudgetExhausted,
      noProgressBudgetExhausted,
      searchCallBudgetExhausted,
    };
  }

  function buildRegexBudgetPayload(resetReason: string | null): {
    max: number;
    remaining: number;
    exhausted: boolean;
    resetOn: string;
    resetReason: string | null;
    searchCallsSinceNewMatches: number;
    searchCallsSinceNewMatchesMax: number;
    noProgressBudgetExhausted: boolean;
    searchCallsUsed: number;
    searchCallsMax: number | null;
    searchCallsRemaining: number | null;
    searchCallBudgetExhausted: boolean;
    exhaustedReason: 'no_match_budget' | 'no_progress_budget' | 'search_call_budget' | null;
    newMatchCount: number | null;
  } {
    const { exhausted, noProgressBudgetExhausted, searchCallBudgetExhausted } = isRegexBudgetExhausted();
    const searchCallsMax = styleReviewSearchCallsMax;
    const searchCallsRemaining = searchCallsMax === null ? null : Math.max(0, searchCallsMax - searchCallsUsed);
    const exhaustedReason = exhausted
      ? (regexNoMatchBudgetExhausted
          ? 'no_match_budget'
          : (searchCallBudgetExhausted ? 'search_call_budget' : 'no_progress_budget'))
      : null;
    return {
      max: REGEX_NO_MATCH_BUDGET_MAX,
      remaining: regexNoMatchBudgetExhausted ? 0 : regexNoMatchBudgetRemaining,
      exhausted,
      resetOn: 'new_unique_regex_matches',
      resetReason,
      searchCallsSinceNewMatches: regexSearchCallsSinceNewMatches,
      searchCallsSinceNewMatchesMax: REGEX_SEARCH_CALLS_WITHOUT_NEW_MATCHES_MAX,
      noProgressBudgetExhausted,
      searchCallsUsed,
      searchCallsMax,
      searchCallsRemaining,
      searchCallBudgetExhausted,
      exhaustedReason,
      newMatchCount: null,
    };
  }

  function buildRegexBudgetMessage(): string {
    const { exhausted, noProgressBudgetExhausted, searchCallBudgetExhausted } = isRegexBudgetExhausted();
    const searchCallsMax = styleReviewSearchCallsMax ?? STYLE_REVIEW_SEARCH_CALLS_MAX_DEFAULT;
    if (exhausted) {
      if (regexNoMatchBudgetExhausted) {
        return 'Regex no-match search budget exhausted. Stop regex searching until you get new matches.';
      }
      if (searchCallBudgetExhausted) {
        return `Search call budget exhausted at ${searchCallsUsed}/${searchCallsMax}. Stop searching.`;
      }
      if (noProgressBudgetExhausted) {
        return `Regex no-progress budget exhausted after ${REGEX_SEARCH_CALLS_WITHOUT_NEW_MATCHES_MAX} searches without new matches. Stop regex searching.`;
      }
    }
    const noProgressRemaining = Math.max(
      0,
      REGEX_SEARCH_CALLS_WITHOUT_NEW_MATCHES_MAX - regexSearchCallsSinceNewMatches
    );
    const searchCallsRemaining = styleReviewSearchCallsMax === null
      ? null
      : Math.max(0, styleReviewSearchCallsMax - searchCallsUsed);
    if (
      regexNoMatchBudgetRemaining <= 1
      || noProgressRemaining <= 2
      || (searchCallsRemaining !== null && searchCallsRemaining <= 3)
    ) {
      if (searchCallsRemaining !== null) {
        return `Regex budget low: no-match ${regexNoMatchBudgetRemaining}/${REGEX_NO_MATCH_BUDGET_MAX}, no-progress ${noProgressRemaining}/${REGEX_SEARCH_CALLS_WITHOUT_NEW_MATCHES_MAX}, search-calls ${searchCallsRemaining}/${searchCallsMax}.`;
      }
      return `Regex budget low: no-match ${regexNoMatchBudgetRemaining}/${REGEX_NO_MATCH_BUDGET_MAX}, no-progress ${noProgressRemaining}/${REGEX_SEARCH_CALLS_WITHOUT_NEW_MATCHES_MAX}.`;
    }
    if (searchCallsRemaining !== null) {
      return `Regex budgets: no-match ${regexNoMatchBudgetRemaining}/${REGEX_NO_MATCH_BUDGET_MAX}, no-progress ${noProgressRemaining}/${REGEX_SEARCH_CALLS_WITHOUT_NEW_MATCHES_MAX}, search-calls ${searchCallsRemaining}/${searchCallsMax}.`;
    }
    return `Regex budgets: no-match ${regexNoMatchBudgetRemaining}/${REGEX_NO_MATCH_BUDGET_MAX}, no-progress ${noProgressRemaining}/${REGEX_SEARCH_CALLS_WITHOUT_NEW_MATCHES_MAX}.`;
  }

  async function ensureDocumentSnapshot(): Promise<{ markdown: string; plain: string } | null> {
    if (
      hasFetchedState
      && cachedDocumentContent !== null
      && cachedPlainDocumentContent !== null
      && !cachedDocumentTruncated
    ) {
      return { markdown: cachedDocumentContent, plain: cachedPlainDocumentContent };
    }

    try {
      throwIfAborted(signal);
      const state = await bridgeGet<BridgeStateResponse>('/state', {
        agentId,
        signal,
      });

      if (state.error && typeof state.error === 'string') {
        console.warn('[http-bridge-tools] Failed to read document for validation:', state.error);
        if (cachedPlainDocumentContent !== null) {
          cachedDocumentContent = cachedDocumentContent ?? cachedPlainDocumentContent;
          return { markdown: cachedDocumentContent, plain: cachedPlainDocumentContent };
        }
        return null;
      }

      const hasPlainTextField = typeof state.plainText === 'string';
      const plainRaw = hasPlainTextField
        ? state.plainText
        : (typeof state.content === 'string' ? state.content : '');
      const markdownRaw = hasPlainTextField
        ? (typeof state.content === 'string' ? state.content : '')
        : (typeof state.markdownContent === 'string' && state.markdownContent.length > 0
          ? state.markdownContent
          : (typeof state.content === 'string' ? state.content : ''));
      const resolvedPlain = hasPlainTextField
        ? plainRaw
        : (plainRaw.length > 0 ? plainRaw : (cachedPlainDocumentContent ?? ''));
      const resolvedMarkdown = markdownRaw.length > 0 ? markdownRaw : resolvedPlain;

      cachedPlainDocumentContent = resolvedPlain;
      cachedDocumentContent = resolvedMarkdown;
      hasFetchedState = true;
      cachedDocumentTruncated = false;

      return {
        markdown: cachedDocumentContent,
        plain: cachedPlainDocumentContent,
      };
    } catch (error) {
      console.warn('[http-bridge-tools] Document validation read failed:', toErrorMessage(error));
      if (cachedPlainDocumentContent !== null) {
        cachedDocumentContent = cachedDocumentContent ?? cachedPlainDocumentContent;
        return { markdown: cachedDocumentContent, plain: cachedPlainDocumentContent };
      }
      return null;
    }
  }

  async function ensureDocumentContent(): Promise<string | null> {
    const snapshot = await ensureDocumentSnapshot();
    return snapshot?.markdown ?? null;
  }

  async function rejectProvisionalMark(markId: string): Promise<void> {
    try {
      throwIfAborted(signal);
      await bridgePost('/marks/reject', { markId }, { agentId, signal });
    } catch (error) {
      // Best-effort cleanup; reconciliation sweeps will retry later if needed.
      console.warn('[http-bridge-tools] Failed to reject provisional mark:', toErrorMessage(error));
    }
  }

  async function createProvisionalMark(change: ProposedChange): Promise<{ markId?: string; error?: string }> {
    if (!canCreateProvisionalMarks) {
      return {};
    }

    const metaFields = buildOrchestrationFields(orchestrationBase, {
      provisional: true,
      orchestrator: false,
    });

    try {
      throwIfAborted(signal);

      if (change.kind === 'comment') {
        const response = await bridgePost<BridgeMarkCreateResponse>(
          '/marks/comment',
          {
            quote: change.quote,
            by: actor,
            text: change.text,
            ...metaFields,
          },
          { agentId, signal }
        );
        if (response.success === false) {
          return { error: response.error ?? 'Failed to create provisional comment' };
        }
        return { markId: extractMarkId(response) };
      }

      const endpoint = SUGGESTION_ENDPOINTS[change.suggestionType];
      const body = change.suggestionType === 'delete'
        ? { quote: change.quote, by: actor, ...metaFields }
        : { quote: change.quote, by: actor, content: change.content, ...metaFields };

      const response = await bridgePost<BridgeMarkCreateResponse>(endpoint, body, {
        agentId,
        signal,
      });
      if (response.success === false) {
        return { error: response.error ?? 'Failed to create provisional suggestion' };
      }
      return { markId: extractMarkId(response) };
    } catch (error) {
      return { error: toErrorMessage(error) };
    }
  }

  const tools: AgentTool[] = [
    {
      name: 'read_document',
      description: 'Read the full document content.',
      inputSchema: {
        type: 'object',
        properties: {},
      },
      handler: async () => {
        try {
          throwIfAborted(signal);
          const state = await bridgeGet<BridgeStateResponse>('/state', {
            agentId,
            signal,
          });

          if (state.error && typeof state.error === 'string') {
            return { success: false, error: state.error };
          }

          const hasPlainTextField = typeof state.plainText === 'string';
          const content = hasPlainTextField
            ? (typeof state.content === 'string' ? state.content : '')
            : (typeof state.markdownContent === 'string' && state.markdownContent.length > 0
              ? state.markdownContent
              : (typeof state.content === 'string' ? state.content : ''));
          const plainRaw = hasPlainTextField
            ? state.plainText
            : (typeof state.content === 'string' ? state.content : '');
          const resolvedPlain = hasPlainTextField
            ? plainRaw
            : (plainRaw.length > 0 ? plainRaw : (cachedPlainDocumentContent ?? ''));
          const documentPath = typeof state.documentPath === 'string' ? state.documentPath : undefined;
          cachedPlainDocumentContent = resolvedPlain;
          cachedDocumentContent = content || resolvedPlain;
          hasFetchedState = true;

          if (isStyleReviewAgent && content.length > STYLE_REVIEW_READ_DOCUMENT_CHAR_CAP) {
            const truncatedContent = content.slice(0, STYLE_REVIEW_READ_DOCUMENT_CHAR_CAP);
            cachedDocumentContent = truncatedContent;
            cachedDocumentTruncated = true;
            return {
              success: true,
              content: truncatedContent,
              documentPath,
              truncated: true,
              totalLength: content.length,
              cap: STYLE_REVIEW_READ_DOCUMENT_CHAR_CAP,
              message: `Document truncated to ${STYLE_REVIEW_READ_DOCUMENT_CHAR_CAP} characters for efficiency. Use search() to scan the full document.`,
            };
          }

          cachedDocumentTruncated = false;
          return {
            success: true,
            content,
            documentPath,
          };
        } catch (error) {
          return handleToolError(error, signal);
        }
      },
    },
    ...(isStyleReviewAgent
      ? [
          {
            name: 'read_style_guide',
            description: 'Read the editorial style guide. Use it as the source of truth for rules.',
            inputSchema: {
              type: 'object',
              properties: {},
            },
            handler: async () => ({
              success: true,
              version: EDITORIAL_STYLE_GUIDE_VERSION,
              charCount: EDITORIAL_STYLE_GUIDE_CHAR_COUNT,
              content: EDITORIAL_STYLE_GUIDE,
            }),
          } satisfies AgentTool,
        ]
      : []),
    {
      name: 'search',
      description: 'Search the document for a pattern. Use type="regex" for regular expressions.',
      inputSchema: {
        type: 'object',
        properties: {
          pattern: {
            type: 'string',
            description: 'The text or regex pattern to search for.',
          },
          type: {
            type: 'string',
            enum: ['text', 'regex'],
            description: 'Search type (default: text).',
          },
        },
        required: ['pattern'],
      },
      handler: async (args) => {
        try {
          throwIfAborted(signal);
          const patternRaw = typeof args.pattern === 'string' ? args.pattern : '';
          if (!patternRaw.trim()) {
            return { success: false, error: 'pattern is required' };
          }

          if (baseFocusAreaId === 'headlines' && headlinesCandidatesListed) {
            return {
              success: false,
              count: 0,
              matches: [],
              error: 'For headlines, do not call search() after list_candidates(); use candidateId-anchored propose_change instead.',
              candidatesListed: headlinesCandidateCount,
            };
          }

          const type = args.type === 'regex'
            ? 'regex'
            : (isStyleReviewAgent ? 'regex' : 'text');
          let resetReason: string | null = null;
          let newMatchCount: number | null = null;

          if (styleReviewSearchCallsMax !== null && searchCallsUsed >= styleReviewSearchCallsMax) {
            return {
              success: false,
              count: 0,
              matches: [],
              error: `No matches budget exhausted: search call budget exhausted (${searchCallsUsed}/${styleReviewSearchCallsMax}).`,
              budget: buildRegexBudgetPayload(resetReason),
              budgetMessage: buildRegexBudgetMessage(),
            };
          }

          if (type === 'regex') {
            const { exhausted, noProgressBudgetExhausted, searchCallBudgetExhausted } = isRegexBudgetExhausted();
            if (exhausted) {
              const exhaustedReasonMessage = searchCallBudgetExhausted
                ? `search call budget exhausted (${searchCallsUsed}/${styleReviewSearchCallsMax ?? STYLE_REVIEW_SEARCH_CALLS_MAX_DEFAULT})`
                : (noProgressBudgetExhausted
                    ? `regex no-progress budget exhausted after ${REGEX_SEARCH_CALLS_WITHOUT_NEW_MATCHES_MAX} searches without new matches`
                    : `0/${REGEX_NO_MATCH_BUDGET_MAX} regex no-match searches remaining`);
              return {
                success: false,
                count: 0,
                matches: [],
                error: `No matches budget exhausted: ${exhaustedReasonMessage}.`,
                budget: buildRegexBudgetPayload(resetReason),
                budgetMessage: buildRegexBudgetMessage(),
              };
            }
          }

          searchCallsUsed += 1;

          const response = await bridgeGet<BridgeSearchResponse>('/search', {
            agentId,
            signal,
            query: { q: patternRaw, type },
          });

          if (response.success === false) {
            const errorMessage = response.error ?? 'Search failed';
            const isNoMatchesError = typeof errorMessage === 'string'
              && errorMessage.toLowerCase().includes('no matches');
            if (type === 'regex' && isNoMatchesError) {
              regexNoMatchBudgetRemaining = Math.max(0, regexNoMatchBudgetRemaining - 1);
              if (regexNoMatchBudgetRemaining <= 0) {
                regexNoMatchBudgetExhausted = true;
              }
              regexSearchCallsSinceNewMatches += 1;
              return {
                success: false,
                count: 0,
                matches: [],
                error: errorMessage,
                budget: buildRegexBudgetPayload(resetReason),
                budgetMessage: buildRegexBudgetMessage(),
              };
            }
            return {
              success: false,
              count: 0,
              matches: [],
              error: errorMessage,
            };
          }

          const matches = summarizeSearchMatches(response.matches);
          const count = typeof response.count === 'number' ? response.count : matches.length;
          const noMatches = count <= 0 || matches.length === 0;
          if (isStyleReviewAgent && matches.length > 0) {
            if (recentSearchMatchTexts.size > 200) {
              recentSearchMatchTexts.clear();
            }
            for (const match of matches) {
              const text = typeof match.text === 'string' ? match.text.trim() : '';
              if (!text) continue;
              recentSearchMatchTexts.add(text.slice(0, 200));
            }
          }

          if (type === 'regex') {
            let hasNewMatches = false;
            if (!noMatches) {
              let newKeys = 0;
              for (const match of matches) {
                const key = buildRegexMatchKey(match);
                if (seenRegexMatchKeys.has(key)) continue;
                seenRegexMatchKeys.add(key);
                newKeys += 1;
              }
              newMatchCount = newKeys;
              hasNewMatches = newKeys > 0;
            } else {
              newMatchCount = 0;
            }

            if (noMatches || !hasNewMatches) {
              regexNoMatchBudgetRemaining = Math.max(0, regexNoMatchBudgetRemaining - 1);
              if (regexNoMatchBudgetRemaining <= 0) {
                regexNoMatchBudgetExhausted = true;
              }
              regexSearchCallsSinceNewMatches += 1;
            } else {
              resetReason = resetRegexNoMatchBudget('new_unique_regex_matches');
            }

            const { exhausted, noProgressBudgetExhausted, searchCallBudgetExhausted } = isRegexBudgetExhausted();
            if (exhausted && !hasNewMatches) {
              const exhaustedPayload = buildRegexBudgetPayload(resetReason);
              exhaustedPayload.newMatchCount = newMatchCount;
              const exhaustedReasonMessage = searchCallBudgetExhausted
                ? `search call budget exhausted (${searchCallsUsed}/${styleReviewSearchCallsMax ?? STYLE_REVIEW_SEARCH_CALLS_MAX_DEFAULT})`
                : (noProgressBudgetExhausted
                    ? `regex no-progress budget exhausted after ${REGEX_SEARCH_CALLS_WITHOUT_NEW_MATCHES_MAX} searches without new matches`
                    : `0/${REGEX_NO_MATCH_BUDGET_MAX} regex no-match searches remaining`);
              return {
                success: false,
                count: 0,
                matches: [],
                error: `No matches budget exhausted: ${exhaustedReasonMessage}.`,
                budget: exhaustedPayload,
                budgetMessage: buildRegexBudgetMessage(),
              };
            }
          }

          const baseResult: Record<string, unknown> = {
            success: true,
            count,
            matches,
          };
          if (type === 'regex') {
            const budgetPayload = buildRegexBudgetPayload(resetReason);
            budgetPayload.newMatchCount = newMatchCount;
            baseResult.budget = budgetPayload;
            baseResult.budgetMessage = buildRegexBudgetMessage();
          }

          return baseResult;
        } catch (error) {
          return handleToolError(error, signal);
        }
      },
    },
    {
      name: 'get_marks',
      description: 'Get existing marks (suggestions and comments) to avoid duplicates and conflicts.',
      inputSchema: {
        type: 'object',
        properties: {},
      },
      handler: async () => {
        try {
          const marks = await fetchMarks({ agentId, actor, signal, mode, proposalCollector });
          return {
            success: true,
            count: marks.length,
            marks,
          };
        } catch (error) {
          return handleToolError(error, signal);
        }
      },
    },
  ];

  if (mode === 'propose' || mode === 'propose-visible') {
    const countsSnapshot = () => proposalCollector!.counts();
    const invalidProposalResponse = (reason: string) => ({
      success: true,
      accepted: false,
      proposalId: null,
      markId: null,
      provisionalError: null,
      reason: `invalid:${reason}`,
      counts: countsSnapshot(),
    });
    const normalizeAndValidate = async (change: ProposedChange): Promise<{
      change: ProposedChange;
      invalidReason: string | null;
    }> => {
      const normalizedChange = normalizeProposedChange(change);
      const baseInvalidReason = validateProposalBase(normalizedChange);
      if (baseInvalidReason) {
        return { change: normalizedChange, invalidReason: baseInvalidReason };
      }
      const snapshot = await ensureDocumentSnapshot();
      if (!snapshot) {
        return { change: normalizedChange, invalidReason: null };
      }
      const docForValidation = normalizedChange.range || normalizedChange.candidateId
        ? snapshot.plain
        : snapshot.markdown;
      return {
        change: normalizedChange,
        invalidReason: validateProposalAgainstDocument(normalizedChange, docForValidation),
      };
    };

    if (isStyleReviewAgent) {
      tools.push({
        name: 'list_candidates',
        description: 'List structural candidates (e.g., headline lines) with stable candidateId and ranges. Use this before proposing structural markdown edits.',
        inputSchema: {
          type: 'object',
          properties: {
            focusAreaId: {
              type: 'string',
              description: 'Optional focus area id to list candidates for (defaults to current focus area).',
            },
          },
        },
        handler: async (args) => {
          try {
            throwIfAborted(signal);
            const requestedFocusAreaId = typeof args?.focusAreaId === 'string'
              ? args.focusAreaId.trim()
              : undefined;
            const { focusAreaId: resolvedFocusAreaId, candidates, cached } = await listStructuralCandidates(requestedFocusAreaId);
            if (!resolvedFocusAreaId) {
              return { success: false, error: 'focusAreaId is required for candidate listing' };
            }
            const supported = resolvedFocusAreaId === 'headlines' || resolvedFocusAreaId === 'lists';
            const message = !supported
              ? `No structural candidate generator is configured for focus area "${resolvedFocusAreaId}" yet.`
              : candidates.length === 0
                ? 'No structural candidates found.'
                : undefined;
            return {
              success: true,
              focusAreaId: resolvedFocusAreaId,
              supported,
              cached,
              count: candidates.length,
              candidates,
              message,
            };
          } catch (error) {
            return handleToolError(error, signal);
          }
        },
      });
    }

    tools.push({
      name: 'propose_change',
      description: 'Propose a suggestion or comment for the orchestrator. In visible mode this also creates provisional marks that may be reconciled later.',
      inputSchema: {
        type: 'object',
        properties: {
          kind: {
            type: 'string',
            enum: ['suggestion', 'comment'],
            description: 'Type of change to propose.',
          },
          suggestionType: {
            type: 'string',
            enum: ['insert', 'delete', 'replace'],
            description: 'For suggestions only: insert, delete, or replace.',
          },
          quote: {
            type: 'string',
            description: 'Exact text to anchor the proposal.',
          },
          content: {
            type: 'string',
            description: 'Replacement or inserted text (required for insert and replace suggestions).',
          },
          text: {
            type: 'string',
            description: 'Comment text (required for comment proposals).',
          },
          rationale: {
            type: 'string',
            description: 'Optional explanation for why this change is needed.',
          },
          candidateId: {
            type: 'string',
            description: 'Structural candidate id from list_candidates(). Required for structural markdown edits in structural focus areas.',
          },
          range: {
            type: 'object',
            description: 'Optional explicit range {from,to} to anchor the proposal.',
            properties: {
              from: { type: 'number' },
              to: { type: 'number' },
            },
            required: ['from', 'to'],
          },
        },
        required: ['kind', 'quote'],
      },
      handler: async (args) => {
        try {
          throwIfAborted(signal);

          if (!proposalCollector) {
            return { success: false, error: 'proposal collector not configured' };
          }

          const quoteRaw = typeof args.quote === 'string' ? args.quote.trim() : '';
          if (!quoteRaw) {
            return { success: false, error: 'quote is required' };
          }

          let scopeWarning: string | null = null;
          let quoteForProposal = quoteRaw;
          const candidateIdRaw = typeof args.candidateId === 'string' ? args.candidateId.trim() : '';
          const requestedRange = normalizeRange(args.range);
          const structuralFocusArea = isStructuralFocusArea(baseFocusAreaId);
          let documentForScope: string | null = null;
          if (isStyleReviewAgent) {
            documentForScope = cachedDocumentContent;
            if (cachedDocumentTruncated) {
              const snapshot = await ensureDocumentSnapshot();
              documentForScope = snapshot?.markdown ?? documentForScope;
            }
            const scope = enforceStyleReviewScope(
              quoteForProposal,
              baseFocusAreaId,
              recentSearchMatchTexts,
              documentForScope
            );
            if (scope?.error) {
              return { success: false, error: scope.error };
            }
            scopeWarning = scope?.warning ?? null;
          }

          const rationaleRaw = typeof args.rationale === 'string' ? args.rationale.trim() : undefined;

          const kindRaw = typeof args.kind === 'string' ? args.kind : '';
          const inferredKind = kindRaw === 'suggestion' || kindRaw === 'comment'
            ? kindRaw
            : (typeof args.suggestionType === 'string' || typeof args.type === 'string')
              ? 'suggestion'
              : typeof args.text === 'string'
                ? 'comment'
                : '';

          if (inferredKind !== 'suggestion' && inferredKind !== 'comment') {
            return { success: false, error: 'kind must be suggestion or comment' };
          }

          let change: ProposedChange;
          if (inferredKind === 'suggestion') {
            const suggestionTypeRaw = typeof args.suggestionType === 'string'
              ? args.suggestionType
              : typeof args.type === 'string'
                ? args.type
                : '';
            if (!(suggestionTypeRaw in SUGGESTION_ENDPOINTS)) {
              return { success: false, error: 'suggestionType must be insert, delete, or replace' };
            }

            const suggestionType = suggestionTypeRaw as keyof typeof SUGGESTION_ENDPOINTS;
            if (isStyleReviewAgent && baseFocusAreaId === 'headlines' && suggestionType === 'delete') {
              return {
                success: false,
                error: 'Delete suggestions are not allowed for headlines. Propose a replace with proper heading markdown instead.',
              };
            }
            let contentRaw = typeof args.content === 'string' ? args.content : undefined;
            const requiresContent = suggestionType === 'insert' || suggestionType === 'replace';
            if (requiresContent && (!contentRaw || contentRaw.length === 0)) {
              return { success: false, error: 'content is required for insert and replace suggestions' };
            }

            if (isStyleReviewAgent && baseFocusAreaId === 'italics') {
              if (suggestionType !== 'replace') {
                return {
                  success: false,
                  error: 'Italics focus area only supports replace suggestions.',
                };
              }
              const contentTrimmed = contentRaw?.trim() ?? '';
              if (!contentTrimmed.includes('*')) {
                return {
                  success: false,
                  error: 'Italics focus proposals must include asterisks in content (quote plain text, propose markdown).',
                };
              }
              const hasPunctOutside = /\*[^*]+\*[.,!?;:]$/.test(contentTrimmed);
              const hasPunctInside = /\*[^*]+[.,!?;:]\*/.test(contentTrimmed);
              if (!hasPunctOutside || hasPunctInside) {
                return {
                  success: false,
                  error: 'Italics focus proposals must move trailing punctuation outside the closing asterisk.',
                };
              }

              const markdownDocument = documentForScope ?? cachedDocumentContent ?? '';
              const contentMatch = contentTrimmed.match(/^\*([^*]+)\*([.,!?;:])$/);
              const quoteHasAsterisks = quoteForProposal.includes('*');
              if (contentMatch && !quoteHasAsterisks && markdownDocument) {
                const inner = contentMatch[1]?.trim();
                const punct = contentMatch[2];
                if (inner && punct) {
                  const originalItalicized = `*${inner}${punct}*`;
                  if (markdownDocument.includes(originalItalicized)) {
                    quoteForProposal = originalItalicized;
                    scopeWarning = scopeWarning ?? 'Italics scope: upgraded plain-text quote to italicized markdown from document.';
                  }
                }
              }
            }

            if (isStyleReviewAgent && baseFocusAreaId === 'quotation-marks') {
              if (suggestionType !== 'replace') {
                return {
                  success: false,
                  error: 'Quotation marks focus area only supports replace suggestions.',
                };
              }
              if (!/["“”]/.test(quoteForProposal)) {
                let upgradedQuote: string | null = null;
                for (const matchText of recentSearchMatchTexts) {
                  if (!/["“”]/.test(matchText)) continue;
                  if (!matchText.includes(quoteForProposal)) continue;
                  if (!upgradedQuote || matchText.length < upgradedQuote.length) {
                    upgradedQuote = matchText;
                  }
                }
                if (upgradedQuote) {
                  quoteForProposal = upgradedQuote;
                  scopeWarning = scopeWarning ?? 'Quotation marks scope: upgraded quote anchor to recent quoted search match.';
                }
              }
              let contentTrimmed = contentRaw?.trim() ?? '';
              const quoteTrimmed = quoteForProposal.trim();
              const quoteHasDoubleQuotes = /["“”]/.test(quoteTrimmed);
              const quoteQuoteChars = quoteTrimmed.match(/["“”]/g) ?? [];
              const autoFixQuotedPunctuation = (quote: string): string | null => {
                const match = quote.match(/^(.*?)(["“”])([^"“”]+)(["”])(.*)$/s);
                if (!match) return null;
                const [, prefix, open, inner, close, suffix] = match;
                const suffixTrimmedStart = suffix.trimStart();
                const punct = suffixTrimmedStart[0] ?? '';
                if (!punct || !',.?!'.includes(punct)) return null;
                const suffixAfterPunct = suffixTrimmedStart.slice(1);
                const innerWithoutTrailingPunct = inner.replace(/[,.?!]$/, '');
                const correctedInner = `${innerWithoutTrailingPunct}${punct}`;
                return `${prefix}${open}${correctedInner}${close}${suffixAfterPunct}`;
              };
              if (quoteHasDoubleQuotes && quoteQuoteChars.length < 2) {
                return {
                  success: false,
                  error: 'Quotation marks focus anchors must include BOTH opening and closing quotes around the quoted text.',
                };
              }
              if (quoteHasDoubleQuotes && !/["“”]/.test(contentTrimmed)) {
                const autoFixed = autoFixQuotedPunctuation(quoteTrimmed);
                if (autoFixed && /["“”]/.test(autoFixed)) {
                  contentRaw = autoFixed;
                  contentTrimmed = autoFixed.trim();
                  scopeWarning = scopeWarning ?? 'Quotation marks scope: auto-corrected content to preserve quotes and move punctuation inside.';
                } else {
                  return {
                    success: false,
                    error: 'Quotation marks focus proposals must preserve quotation marks in content.',
                  };
                }
              }
              const contentQuoteChars = contentTrimmed.match(/["“”]/g) ?? [];
              if (quoteHasDoubleQuotes && contentQuoteChars.length < 2) {
                return {
                  success: false,
                  error: 'Quotation marks focus proposals must keep the quoted span wrapped in quotes.',
                };
              }
              const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
              const quotedTextMatches = Array.from(quoteTrimmed.matchAll(/["“”]([^"“”]+)["“”]/g));
              const quotedTexts = quotedTextMatches
                .map((match) => match[1]?.trim())
                .filter((text): text is string => Boolean(text));
              if (quoteHasDoubleQuotes && quotedTexts.length === 0 && quoteQuoteChars.length >= 2) {
                return {
                  success: false,
                  error: 'Quotation marks focus anchors must include a full quoted span like "quoted text".',
                };
              }
              for (const quotedText of quotedTexts) {
                const quotedPattern = new RegExp(`[\"“”]\\s*${escapeRegExp(quotedText)}\\s*[.,!?;:]?\\s*[\"”]`);
                if (!quotedPattern.test(contentTrimmed)) {
                  return {
                    success: false,
                    error: 'Quotation marks focus proposals must keep the quoted text unchanged and wrapped in quotes; only move punctuation.',
                  };
                }
              }
              const quoteTextMatch = quoteTrimmed.match(/["“”]([^"“”]+)["“”]/);
              const quotedText = quoteTextMatch?.[1]?.trim();
              if (quotedText && !contentTrimmed.includes(quotedText)) {
                return {
                  success: false,
                  error: 'Quotation marks focus proposals must keep the quoted text unchanged and only move punctuation.',
                };
              }

              const commaOutsideQuotes = /["“”][^"“”]+["“”]\s*,/.test(quoteTrimmed)
                || /["“”][^"“”]+[?!]["“”]\s*,/.test(quoteTrimmed);
              if (commaOutsideQuotes) {
                if (!contentTrimmed.includes(',')) {
                  return {
                    success: false,
                    error: 'Keep the comma and move it inside the closing quote (e.g., "text", → "text,").',
                  };
                }
                const commaInsideQuotes = /["“”][^"“”]+,[\"”]/.test(contentTrimmed)
                  || /["“”][^"“”]+[?!],[\"”]/.test(contentTrimmed);
                if (!commaInsideQuotes) {
                  return {
                    success: false,
                    error: 'Comma must be inside the closing quote (e.g., "text", → "text,").',
                  };
                }
              }

              const periodOutsideQuotes = /["“”][^"“”]+["“”]\s*\./.test(quoteTrimmed)
                || /["“”][^"“”]+[?!]["“”]\s*\./.test(quoteTrimmed);
              if (periodOutsideQuotes) {
                if (!contentTrimmed.includes('.')) {
                  return {
                    success: false,
                    error: 'Keep the period and move it inside the closing quote (e.g., "text". → "text.").',
                  };
                }
                const periodInsideQuotes = /["“”][^"“”]+\.[\"”]/.test(contentTrimmed)
                  || /["“”][^"“”]+[?!]\.[\"”]/.test(contentTrimmed);
                if (!periodInsideQuotes) {
                  return {
                    success: false,
                    error: 'Period must be inside the closing quote (e.g., "text". → "text.").',
                  };
                }
              }

              const questionOutsideQuotes = /["“”][^"“”]+["“”]\s*\?/.test(quoteTrimmed);
              if (questionOutsideQuotes && !contentTrimmed.includes('?')) {
                return {
                  success: false,
                  error: 'Do not remove the question mark; place it appropriately relative to the quotes.',
                };
              }
            }

            if (isStyleReviewAgent && baseFocusAreaId === 'headlines') {
              const sanitized = sanitizeHeadlinesQuote(quoteForProposal, contentRaw, cachedDocumentContent);
              if (sanitized.adjusted) {
                quoteForProposal = sanitized.quote;
                scopeWarning = scopeWarning ?? sanitized.reason ?? null;
              }
            }

            if (isStyleReviewAgent && baseFocusAreaId === 'lists') {
              if (!candidateIdRaw) {
                return {
                  success: false,
                  error: 'Lists focus requires candidateId anchoring from list_candidates().',
                };
              }
              const insertsListMarkers = /^\s*(?:[-*+]\s+|\d+\.\s+)/m.test(contentRaw);
              if (insertsListMarkers) {
                return {
                  success: false,
                  error: 'Do not add list markers (*, -, 1.). Edit the list item text only.',
                };
              }
            }

            const structuralIntent = structuralFocusArea && (isStructuralMarkdown(contentRaw) || isStructuralMarkdown(quoteForProposal));
            if (structuralIntent && !candidateIdRaw) {
              return {
                success: false,
                error: 'Structural edits require candidateId from list_candidates().',
              };
            }

            change = {
              kind: 'suggestion',
              suggestionType,
              quote: quoteForProposal,
              content: contentRaw,
              rationale: rationaleRaw,
            };
          } else {
            const textRaw = typeof args.text === 'string' ? args.text.trim() : '';
            if (!textRaw) {
              return { success: false, error: 'text is required for comment proposals' };
            }
            change = {
              kind: 'comment',
              quote: quoteForProposal,
              text: textRaw,
              rationale: rationaleRaw,
            };
          }

          let structuralCandidate: StructuralCandidate | null = null;
          if (candidateIdRaw) {
            const { focusAreaId: resolvedFocusAreaId, candidates } = await listStructuralCandidates(baseFocusAreaId);
            if (!resolvedFocusAreaId) {
              return { success: false, error: 'focusAreaId is required for candidateId anchoring' };
            }
            structuralCandidate = candidates.find((candidate) => candidate.candidateId === candidateIdRaw) ?? null;
            if (!structuralCandidate) {
              return { success: false, error: `candidateId not found for focus area "${resolvedFocusAreaId}"` };
            }
          }

          if (structuralCandidate) {
            let candidateQuote = structuralCandidate.text;
            if (structuralCandidate.range) {
              const snapshot = await ensureDocumentSnapshot();
              if (snapshot) {
                const docLength = snapshot.plain.length;
                const clampedFrom = Math.max(0, Math.min(structuralCandidate.range.from, docLength));
                const clampedTo = Math.max(clampedFrom, Math.min(structuralCandidate.range.to, docLength));
                const rangeQuote = snapshot.plain.slice(clampedFrom, clampedTo).trim();
                if (rangeQuote) {
                  candidateQuote = rangeQuote;
                }
              }
            }
            if (candidateQuote !== quoteForProposal) {
              quoteForProposal = candidateQuote;
              scopeWarning = scopeWarning ?? 'candidate_quote_clamped';
            }
          }
          if (
            structuralCandidate
            && isStyleReviewAgent
            && baseFocusAreaId === 'headlines'
            && change.kind === 'suggestion'
            && change.suggestionType === 'replace'
          ) {
            const label = structuralCandidate.signals.hedDekLabel;

            if (label === 'hed-dek') {
              const pair = extractHedDekPair(quoteForProposal);
              if (pair.hed && pair.dek) {
                const trimmedContent = change.content?.trim() ?? '';
                const lines = trimmedContent.split('\n').map((line) => line.trim()).filter(Boolean);
                const hedLine = lines.find((line) => /^#(?!#)\s+/.test(line)) ?? `# ${pair.hed}`;
                const dekLine = lines.find((line) => /^##(?!#)\s+/.test(line)) ?? `## ${pair.dek}`;
                const pairedContent = `${hedLine}\n${dekLine}`;
                if (pairedContent !== trimmedContent) {
                  change = {
                    ...change,
                    content: pairedContent,
                  };
                  scopeWarning = scopeWarning ?? 'headlines_hed_dek_pair_normalized';
                }
              }
            }

            const trimmedContent = change.content?.trim();
            if (trimmedContent && !HEADING_MARKDOWN_RE.test(trimmedContent)) {
              let headingPrefix: string | null = null;
              if (label === 'hed') headingPrefix = '#';
              else if (label === 'dek') headingPrefix = '##';
              else if (label === null) headingPrefix = '##';
              if (headingPrefix) {
                change = {
                  ...change,
                  content: `${headingPrefix} ${trimmedContent}`,
                };
                scopeWarning = scopeWarning ?? 'headlines_heading_prefix_added';
              }
            }
          }

          const effectiveRange = structuralCandidate?.range ?? requestedRange;
          if (effectiveRange) {
            change = {
              ...change,
              range: effectiveRange,
            };
          }
          if (candidateIdRaw) {
            change = {
              ...change,
              candidateId: structuralCandidate?.candidateId ?? candidateIdRaw,
              quote: quoteForProposal,
            };
          } else if (quoteForProposal !== change.quote) {
            change = {
              ...change,
              quote: quoteForProposal,
            };
          }

          const { change: normalizedChange, invalidReason } = await normalizeAndValidate(change);
          if (invalidReason) {
            return invalidProposalResponse(invalidReason);
          }

          const provisionalResult = await createProvisionalMark(normalizedChange);
          const result = proposalCollector.add(normalizedChange, { markId: provisionalResult.markId });
          onToolEvent?.({ type: 'proposals', count: result.counts.total, focusAreaId: baseFocusAreaId });
          if (!result.accepted && provisionalResult.markId) {
            await rejectProvisionalMark(provisionalResult.markId);
          }
          return {
            success: result.success,
            accepted: result.accepted,
            proposalId: result.id ?? null,
            markId: provisionalResult.markId ?? null,
            provisionalError: provisionalResult.error ?? null,
            reason: result.reason ?? null,
            counts: result.counts,
            scopeWarning,
          };
        } catch (error) {
          return handleToolError(error, signal);
        }
      },
    });

    tools.push(
      {
        name: 'create_suggestion',
        description: 'Propose a suggestion by quoting the exact text to change. In visible mode this also creates a provisional mark.',
        inputSchema: {
          type: 'object',
          properties: {
            type: {
              type: 'string',
              enum: ['insert', 'delete', 'replace'],
              description: 'Type of suggestion.',
            },
            quote: {
              type: 'string',
              description: 'Exact text to match in the document.',
            },
            content: {
              type: 'string',
              description: 'Replacement or inserted text (required for insert and replace).',
            },
            rationale: {
              type: 'string',
              description: 'Optional explanation for why this change is needed.',
            },
          },
          required: ['type', 'quote'],
        },
        handler: async (args) => {
          try {
            throwIfAborted(signal);

            if (!proposalCollector) {
              return { success: false, error: 'proposal collector not configured' };
            }

            const typeRaw = typeof args.type === 'string' ? args.type : '';
            if (!(typeRaw in SUGGESTION_ENDPOINTS)) {
              return { success: false, error: 'type must be insert, delete, or replace' };
            }

            const quoteRaw = typeof args.quote === 'string' ? args.quote.trim() : '';
            if (!quoteRaw) {
              return { success: false, error: 'quote is required' };
            }

            const suggestionType = typeRaw as keyof typeof SUGGESTION_ENDPOINTS;
            const contentRaw = typeof args.content === 'string' ? args.content : undefined;
            const requiresContent = suggestionType === 'insert' || suggestionType === 'replace';
            if (requiresContent && (!contentRaw || contentRaw.length === 0)) {
              return { success: false, error: 'content is required for insert and replace suggestions' };
            }

            const rationaleRaw = typeof args.rationale === 'string' ? args.rationale.trim() : undefined;
            const change: ProposedChange = {
              kind: 'suggestion',
              suggestionType,
              quote: quoteRaw,
              content: contentRaw,
              rationale: rationaleRaw,
            };

            const { change: normalizedChange, invalidReason } = await normalizeAndValidate(change);
            if (invalidReason) {
              return invalidProposalResponse(invalidReason);
            }

            const provisionalResult = await createProvisionalMark(normalizedChange);
            const result = proposalCollector.add(normalizedChange, { markId: provisionalResult.markId });
            if (!result.accepted && provisionalResult.markId) {
              await rejectProvisionalMark(provisionalResult.markId);
            }

            return {
              success: result.success,
              accepted: result.accepted,
              proposalId: result.id ?? null,
              markId: provisionalResult.markId ?? null,
              provisionalError: provisionalResult.error ?? null,
              reason: result.reason ?? null,
              counts: result.counts,
            };
          } catch (error) {
            return handleToolError(error, signal);
          }
        },
      },
      {
        name: 'add_comment',
        description: 'Propose a comment on quoted text. In visible mode this also creates a provisional mark.',
        inputSchema: {
          type: 'object',
          properties: {
            quote: {
              type: 'string',
              description: 'Exact text to comment on.',
            },
            text: {
              type: 'string',
              description: 'Comment text to add.',
            },
            rationale: {
              type: 'string',
              description: 'Optional explanation for why this comment is needed.',
            },
          },
          required: ['quote', 'text'],
        },
        handler: async (args) => {
          try {
            throwIfAborted(signal);

            if (!proposalCollector) {
              return { success: false, error: 'proposal collector not configured' };
            }

            const quoteRaw = typeof args.quote === 'string' ? args.quote.trim() : '';
            const textRaw = typeof args.text === 'string' ? args.text.trim() : '';

            if (!quoteRaw) {
              return { success: false, error: 'quote is required' };
            }
            if (!textRaw) {
              return { success: false, error: 'text is required' };
            }

            const rationaleRaw = typeof args.rationale === 'string' ? args.rationale.trim() : undefined;
            const change: ProposedChange = {
              kind: 'comment',
              quote: quoteRaw,
              text: textRaw,
              rationale: rationaleRaw,
            };

            const { change: normalizedChange, invalidReason } = await normalizeAndValidate(change);
            if (invalidReason) {
              return invalidProposalResponse(invalidReason);
            }

            const provisionalResult = await createProvisionalMark(normalizedChange);
            const result = proposalCollector.add(normalizedChange, { markId: provisionalResult.markId });
            if (!result.accepted && provisionalResult.markId) {
              await rejectProvisionalMark(provisionalResult.markId);
            }

            return {
              success: result.success,
              accepted: result.accepted,
              proposalId: result.id ?? null,
              markId: provisionalResult.markId ?? null,
              provisionalError: provisionalResult.error ?? null,
              reason: result.reason ?? null,
              counts: result.counts,
            };
          } catch (error) {
            return handleToolError(error, signal);
          }
        },
      }
    );

    if (isStyleReviewAgent) {
      return tools.filter((tool) => tool.name !== 'create_suggestion' && tool.name !== 'add_comment');
    }
    return tools;
  }

  tools.push(
    {
      name: 'create_suggestion',
      description: 'Create a suggestion by quoting the exact text to change.',
      inputSchema: {
        type: 'object',
        properties: {
          type: {
            type: 'string',
            enum: ['insert', 'delete', 'replace'],
            description: 'Type of suggestion.',
          },
          quote: {
            type: 'string',
            description: 'Exact text to match in the document.',
          },
          content: {
            type: 'string',
            description: 'Replacement or inserted text (required for insert and replace).',
          },
        },
        required: ['type', 'quote'],
      },
      handler: async (args) => {
        try {
          throwIfAborted(signal);

          const type = typeof args.type === 'string' ? args.type : '';
          if (!(type in SUGGESTION_ENDPOINTS)) {
            return { success: false, error: 'type must be insert, delete, or replace' };
          }

          const quoteRaw = typeof args.quote === 'string' ? args.quote : '';
          if (!quoteRaw.trim()) {
            return { success: false, error: 'quote is required' };
          }

          const contentRaw = typeof args.content === 'string' ? args.content : undefined;
          const requiresContent = type === 'insert' || type === 'replace';
          if (requiresContent && (!contentRaw || contentRaw.length === 0)) {
            return { success: false, error: 'content is required for insert and replace suggestions' };
          }

          const endpoint = SUGGESTION_ENDPOINTS[type as keyof typeof SUGGESTION_ENDPOINTS];
          const body = type === 'delete'
            ? { quote: quoteRaw, by: actor, ...applyOrchestrationFields }
            : { quote: quoteRaw, by: actor, content: contentRaw, ...applyOrchestrationFields };

          const response = await bridgePost<Record<string, unknown>>(endpoint, body, {
            agentId,
            signal,
          });
          return response;
        } catch (error) {
          return handleToolError(error, signal);
        }
      },
    },
    {
      name: 'add_comment',
      description: 'Add a comment on quoted text. Use this when a suggestion already exists.',
      inputSchema: {
        type: 'object',
        properties: {
          quote: {
            type: 'string',
            description: 'Exact text to comment on.',
          },
          text: {
            type: 'string',
            description: 'Comment text to add.',
          },
        },
        required: ['quote', 'text'],
      },
      handler: async (args) => {
        try {
          throwIfAborted(signal);
          const quoteRaw = typeof args.quote === 'string' ? args.quote : '';
          const textRaw = typeof args.text === 'string' ? args.text : '';

          if (!quoteRaw.trim()) {
            return { success: false, error: 'quote is required' };
          }
          if (!textRaw.trim()) {
            return { success: false, error: 'text is required' };
          }

          const response = await bridgePost<Record<string, unknown>>(
            '/marks/comment',
            { quote: quoteRaw, by: actor, text: textRaw, ...applyOrchestrationFields },
            { agentId, signal }
          );
          return response;
        } catch (error) {
          return handleToolError(error, signal);
        }
      },
    }
  );

  return tools;
}
