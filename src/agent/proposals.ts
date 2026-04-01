export type ProposalKind = 'suggestion' | 'comment';
export type SuggestionType = 'insert' | 'delete' | 'replace';

export interface ProposedRange {
  from: number;
  to: number;
}

export interface ProposedSuggestion {
  kind: 'suggestion';
  suggestionType: SuggestionType;
  quote: string;
  content?: string;
  rationale?: string;
  candidateId?: string;
  range?: ProposedRange;
}

export interface ProposedComment {
  kind: 'comment';
  quote: string;
  text: string;
  rationale?: string;
  candidateId?: string;
  range?: ProposedRange;
}

export type ProposedChange = ProposedSuggestion | ProposedComment;

export interface ProposalSource {
  agentId: string;
  focusAreaId: string;
  focusAreaName: string;
}

export interface SubAgentProposal extends ProposalSource {
  id: string;
  createdAt: number;
  change: ProposedChange;
  markId?: string;
}

export interface ProposalCounts {
  total: number;
  suggestions: number;
  comments: number;
}

export interface ProposalAddResult {
  success: boolean;
  accepted: boolean;
  id?: string;
  markId?: string;
  reason?: string;
  counts: ProposalCounts;
}

export interface ProposalAddMeta {
  markId?: string;
}

export interface ProposalCollector {
  add(change: ProposedChange, meta?: ProposalAddMeta): ProposalAddResult;
  list(): SubAgentProposal[];
  counts(): ProposalCounts;
}

export interface CreateProposalCollectorOptions {
  source: ProposalSource;
  maxProposals?: number;
}

export interface DedupedProposalResult {
  proposals: SubAgentProposal[];
  duplicatesRemoved: number;
  truncated: number;
  invalidRemoved: number;
  invalidReasons: Record<string, number>;
}

const DEFAULT_MAX_PROPOSALS_PER_AGENT = 200;
const DEFAULT_MAX_PROPOSALS_FOR_SYNTHESIS = 400;

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function extractHeadingTitle(content: string): string | null {
  const firstLine = content.trim().split('\n')[0] ?? '';
  const match = firstLine.match(/^#{1,6}\s+(.+)$/);
  if (!match) return null;
  const title = match[1]?.trim();
  return title ? title : null;
}

function documentHasHeading(title: string, document: string): boolean {
  if (!title.trim()) return false;
  const pattern = new RegExp(`^#{1,6}\\s+${escapeRegex(title)}\\s*$`, 'mi');
  return pattern.test(document);
}

function normalizeForComparison(value: string): string {
  return normalizeWhitespace(value)
    .replace(/^#{1,6}\s+/, '')
    .replace(/^[*-]\s+/, '')
    .replace(/[*_`]/g, '')
    .toLowerCase();
}

function hasPrefixMismatchLargeReplace(quote: string, content: string): boolean {
  const quoteNorm = normalizeForComparison(quote);
  const contentNorm = normalizeForComparison(content);
  if (!quoteNorm || !contentNorm) return false;

  if (contentNorm.includes(quoteNorm) && !contentNorm.startsWith(quoteNorm)) {
    return true;
  }

  const quoteWords = quoteNorm.split(' ').filter(Boolean);
  const contentWords = contentNorm.split(' ').filter(Boolean);
  if (quoteWords.length < 4 || contentWords.length < 4) return false;

  const prefixLength = Math.min(3, quoteWords.length, contentWords.length);
  const quotePrefix = quoteWords.slice(0, prefixLength).join(' ');
  const contentPrefix = contentWords.slice(0, prefixLength).join(' ');
  if (quotePrefix === contentPrefix) return false;

  const contentLonger = contentWords.length > quoteWords.length + 2
    || contentNorm.length > quoteNorm.length * 1.2;
  return contentLonger;
}

function countCommaBeforeConjunction(value: string): number {
  const normalized = normalizeWhitespace(value);
  if (!normalized) return 0;
  const matches = normalized.match(/,\s+(and|or)\b/gi);
  return matches ? matches.length : 0;
}

function serialCommaOvercorrection(quote: string, content: string): boolean {
  const added = countCommaBeforeConjunction(content) - countCommaBeforeConjunction(quote);
  if (added <= 1) return false;
  return !/[.!?;]/.test(quote);
}

function hasCommaBeforeEndPunctuation(text: string): boolean {
  const normalized = normalizeWhitespace(text);
  if (!normalized) return false;
  return /,\s*[.?!](?:\s|$)/.test(normalized);
}

function countUppercaseLetters(value: string): number {
  const matches = value.match(/[A-Z]/g);
  return matches ? matches.length : 0;
}

function isSignificantLowercasing(quote: string, content: string): boolean {
  const quoteUpper = countUppercaseLetters(quote);
  const contentUpper = countUppercaseLetters(content);
  if (quoteUpper < 3) return false;
  return contentUpper <= Math.max(1, Math.floor(quoteUpper / 2));
}

function capitalizesYesNoAfterColon(quote: string, content: string): boolean {
  const quoteMatch = quote.match(/:\s+(yes|no)\b/);
  const contentMatch = content.match(/:\s+(Yes|No)\b/);
  if (!quoteMatch || !contentMatch) return false;
  return true;
}

function isHeadingLine(line: string): boolean {
  return /^\s*(#{1,6}\s|hed:|dek:)/i.test(line);
}

function indexIsInHeading(document: string, index: number): boolean {
  const lineStart = document.lastIndexOf('\n', index) + 1;
  const lineEndRaw = document.indexOf('\n', index);
  const lineEnd = lineEndRaw === -1 ? document.length : lineEndRaw;
  const line = document.slice(lineStart, lineEnd);
  return isHeadingLine(line);
}

function previousNonSpaceChar(text: string, index: number): string {
  let cursor = index;
  while (cursor >= 0) {
    const ch = text[cursor] ?? '';
    if (ch && !/\s/.test(ch)) return ch;
    cursor -= 1;
  }
  return '';
}

function hasMidSentenceCapitalizedOccurrence(document: string, token: string): boolean {
  if (!token) return false;
  const pattern = new RegExp(`\\b${escapeRegex(token)}\\b`, 'g');
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(document)) !== null) {
    const index = typeof match.index === 'number' ? match.index : -1;
    if (index < 0) continue;
    if (indexIsInHeading(document, index)) continue;

    const prev = previousNonSpaceChar(document, index - 1);
    if (prev && /[A-Za-z0-9]/.test(prev)) {
      return true;
    }
  }
  return false;
}

function isLikelyProperNounToken(token: string, document: string): boolean {
  if (!token) return false;
  if (COMMON_ABBREVIATIONS.has(token.toUpperCase())) return true;
  if (token.length <= 6 && token === token.toUpperCase()) return true;
  if (/[A-Z]/.test(token.slice(1))) return true;
  if (hasMidSentenceCapitalizedOccurrence(document, token)) return true;
  return false;
}

function capitalizesAfterColonLikelyIncorrect(quote: string, content: string, document: string): boolean {
  if (quote.toLowerCase() !== content.toLowerCase()) return false;

  const colonWordPattern = /:\s+([A-Za-z][A-Za-z'\u2019-]*)/g;
  const quoteMatches = Array.from(quote.matchAll(colonWordPattern));
  const contentMatches = Array.from(content.matchAll(colonWordPattern));
  if (quoteMatches.length === 0 || quoteMatches.length !== contentMatches.length) return false;

  for (let i = 0; i < quoteMatches.length; i += 1) {
    const quoteMatch = quoteMatches[i];
    const contentMatch = contentMatches[i];
    if (!quoteMatch || !contentMatch) continue;
    if (quoteMatch.index !== contentMatch.index) continue;

    const quoteToken = quoteMatch[1] ?? '';
    const contentToken = contentMatch[1] ?? '';
    if (!quoteToken || !contentToken) continue;
    if (quoteToken.toLowerCase() !== contentToken.toLowerCase()) continue;

    const quoteFirst = quoteToken[0] ?? '';
    const contentFirst = contentToken[0] ?? '';
    if (!/[a-z]/.test(quoteFirst) || !/[A-Z]/.test(contentFirst)) continue;

    const colonIndex = quoteMatch.index ?? -1;
    const prev = colonIndex > 0 ? previousNonSpaceChar(quote, colonIndex - 1) : '';
    if (/[.!?]/.test(prev)) continue;
    if (isLikelyProperNounToken(contentToken, document)) continue;

    return true;
  }

  return false;
}

const NO_CHANGE_COMMENT_PATTERNS: RegExp[] = [
  /\bno changes?\s+needed\b/i,
  /\bno edits?\s+needed\b/i,
  /\bno changes?\s+required\b/i,
  /\bno changes?\s+necessary\b/i,
  /\bno issues?\s+found\b/i,
  /\balready correct\b/i,
];

const POSITIVE_COMMENT_PHRASES = [
  'correctly formatted',
  'correctly punctuated',
  'correct sentence case',
  'looks good',
  'is correct',
];

const COMMENT_ACTION_WORDS = [
  'consider',
  'should',
  'suggest',
  'issue',
  'fix',
  'change',
  'needs',
  'must',
  'however',
  'but',
];

function commentAppearsNoIssue(text: string): boolean {
  if (!text) return false;
  const lower = text.toLowerCase();
  if (NO_CHANGE_COMMENT_PATTERNS.some((pattern) => pattern.test(text))) {
    return true;
  }

  const hasPositivePhrase = POSITIVE_COMMENT_PHRASES.some((phrase) => lower.includes(phrase));
  if (!hasPositivePhrase) return false;

  const hasActionWord = COMMENT_ACTION_WORDS.some((word) => lower.includes(word));
  return !hasActionWord;
}

function moveTerminalPunctuationOutsideItalics(text: string): string | null {
  const trimmed = text.trim();
  const match = trimmed.match(/^\*(.+?)([.!?])\s*\*$/s);
  if (!match) return null;
  const [, inner, punct] = match;
  const normalizedInner = inner.trimEnd();
  if (!normalizedInner) return null;
  return `*${normalizedInner}*${punct}`;
}

function normalizeRange(range: ProposedRange | undefined): ProposedRange | undefined {
  if (!range) return undefined;
  const from = Number(range.from);
  const to = Number(range.to);
  if (!Number.isFinite(from) || !Number.isFinite(to)) return undefined;
  const fromInt = Math.max(0, Math.floor(from));
  const toInt = Math.max(fromInt, Math.floor(to));
  return { from: fromInt, to: toInt };
}

export function normalizeProposedChange(change: ProposedChange): ProposedChange {
  const normalizedRange = normalizeRange(change.range);
  const rangeChanged = normalizedRange?.from !== change.range?.from
    || normalizedRange?.to !== change.range?.to;

  if (change.kind !== 'suggestion') {
    if (!rangeChanged) return change;
    return {
      ...change,
      range: normalizedRange,
    };
  }
  if (change.suggestionType !== 'replace' || !change.content) {
    if (!rangeChanged) return change;
    return {
      ...change,
      range: normalizedRange,
    };
  }

  let normalizedContent = change.content.trimEnd();
  const italicsNormalized = moveTerminalPunctuationOutsideItalics(normalizedContent);
  if (italicsNormalized) {
    normalizedContent = italicsNormalized;
  }

  const contentChanged = normalizedContent !== change.content;
  if (!contentChanged && !rangeChanged) {
    return change;
  }

  return {
    ...change,
    content: normalizedContent,
    range: normalizedRange,
  };
}

function buildChangeKey(change: ProposedChange): string {
  const quoteKey = normalizeWhitespace(change.quote);
  const rangeKey = change.range ? `|range:${change.range.from}-${change.range.to}` : '';
  if (change.kind === 'suggestion') {
    const contentKey = change.content ? normalizeWhitespace(change.content) : '';
    return `suggestion|${change.suggestionType}|${quoteKey}|${contentKey}${rangeKey}`;
  }
  return `comment|${quoteKey}|${normalizeWhitespace(change.text)}${rangeKey}`;
}

function incrementReason(counts: Record<string, number>, reason: string): void {
  counts[reason] = (counts[reason] ?? 0) + 1;
}

function isAlphabetic(char: string): boolean {
  return /^[A-Za-z]$/.test(char);
}

function isCaseOnlyLoweringAtStart(quote: string, content: string): boolean {
  const q = quote.trim();
  const c = content.trim();
  if (!q || !c) return false;
  const qFirst = q[0];
  const cFirst = c[0];
  if (!isAlphabetic(qFirst) || !isAlphabetic(cFirst)) return false;
  if (qFirst.toLowerCase() !== cFirst.toLowerCase()) return false;
  if (qFirst !== qFirst.toUpperCase()) return false;
  if (cFirst !== qFirst.toLowerCase()) return false;
  return q.slice(1) === c.slice(1);
}

function isLargeRewrite(quote: string, content: string): boolean {
  const quoteLength = normalizeWhitespace(quote).length;
  const contentLength = normalizeWhitespace(content).length;
  if (quoteLength === 0 || contentLength === 0) return false;
  const delta = contentLength - quoteLength;

  if (delta >= 120) return true;
  if (quoteLength >= 80 && contentLength > quoteLength * 1.5) return true;
  if (quoteLength >= 40 && delta >= 80 && contentLength > quoteLength * 1.8) return true;

  return false;
}

const SENTENCE_TERMINATOR_PATTERN = /[.!?](?=\s|$)/g;

function countSentenceTerminators(text: string): number {
  const normalized = normalizeWhitespace(text);
  if (!normalized) return 0;
  const matches = normalized.match(SENTENCE_TERMINATOR_PATTERN);
  return matches ? matches.length : 0;
}

function reducesSentenceCount(quote: string, content: string): boolean {
  const quoteCount = countSentenceTerminators(quote);
  if (quoteCount <= 1) return false;
  const contentCount = countSentenceTerminators(content);
  return contentCount < quoteCount;
}

const SAFE_DELETE_MAX_LENGTH = 30;
const NUMERIC_HYPHEN_COMPOUND_PATTERN = /\b\d{1,4}-[A-Za-z]/;
const NUMERIC_EN_DASH_COMPOUND_PATTERN = /\b\d{1,4}\u2013[A-Za-z]/;

function isUnsafeDelete(quote: string): boolean {
  const normalized = normalizeWhitespace(quote);
  if (!normalized) return false;
  if (normalized.length <= SAFE_DELETE_MAX_LENGTH) return false;
  return /[A-Za-z0-9]/.test(normalized);
}

function replacesNumericHyphenCompoundWithEnDash(quote: string, content: string): boolean {
  if (!NUMERIC_HYPHEN_COMPOUND_PATTERN.test(quote)) return false;
  return NUMERIC_EN_DASH_COMPOUND_PATTERN.test(content);
}

function isHedOrDekQuote(quote: string): boolean {
  const trimmed = quote.trimStart();
  return /^hed:/i.test(trimmed) || /^dek:/i.test(trimmed);
}

const JOB_TITLE_KEYWORD_PATTERN = /\b(editor|chief|officer|president|vice president|vice-president|vp|director|manager|engineer|founder|cofounder|co-founder|ceo|cto|cfo|coo)\b/i;

function focusAreaMatches(focusAreaName: string, requiredTerms: string[]): boolean {
  const lower = focusAreaName.toLowerCase();
  return requiredTerms.every((term) => lower.includes(term));
}

function isItalicizedQuote(quote: string): boolean {
  const trimmed = quote.trimStart();
  if (/^\*\s/.test(trimmed)) return false;
  return /^\*(?!\s).+\*/s.test(trimmed);
}

function isHedOrH1Quote(quote: string): boolean {
  const trimmed = quote.trimStart();
  return /^hed:/i.test(trimmed) || /^#\s+/.test(trimmed);
}

function containsJobTitleKeyword(quote: string): boolean {
  return JOB_TITLE_KEYWORD_PATTERN.test(quote);
}

function focusAreaIdOrNameIncludes(proposal: SubAgentProposal, needle: string): boolean {
  const idLower = proposal.focusAreaId.toLowerCase();
  const nameLower = proposal.focusAreaName.toLowerCase();
  const needleLower = needle.toLowerCase();
  return idLower.includes(needleLower) || nameLower.includes(needleLower);
}

function focusAreaIsHeadingConversion(proposal: SubAgentProposal): boolean {
  if (focusAreaIdOrNameIncludes(proposal, 'section-headings')) return true;
  if (focusAreaIdOrNameIncludes(proposal, 'headings')) return true;
  const nameLower = proposal.focusAreaName.toLowerCase();
  return nameLower.includes('heading');
}

function focusAreaIsNumberFormatting(proposal: SubAgentProposal): boolean {
  if (focusAreaIdOrNameIncludes(proposal, 'number-formatting')) return true;
  const nameLower = proposal.focusAreaName.toLowerCase();
  return nameLower.includes('number') || nameLower.includes('numeric');
}

function containsNewline(value: string | undefined): boolean {
  return typeof value === 'string' && value.includes('\n');
}

function isHeadingLabelLine(line: string): boolean {
  return /^\s*(hed:|dek:|#{1,6}\s+)/i.test(line.trim());
}

function multilineQuoteIsHeadingLabels(quote: string): boolean {
  const lines = quote
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length <= 1) return false;
  return lines.every((line) => isHeadingLabelLine(line));
}

function isStandaloneHeadingLikeLine(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) return false;
  if (isHeadingLabelLine(trimmed)) return true;
  // Reject obviously multi-sentence lines.
  const terminators = trimmed.match(/[.!?](?=\s|$)/g);
  if (terminators && terminators.length > 1) return false;
  return true;
}

const NUMBER_WORD_PATTERN = /\b(zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand|million|billion|percent)\b/gi;

function extractNumberWordCounts(text: string): Map<string, number> {
  const counts = new Map<string, number>();
  const pattern = new RegExp(NUMBER_WORD_PATTERN);
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    const raw = match[1] ?? '';
    const word = raw.toLowerCase();
    if (!word) continue;
    counts.set(word, (counts.get(word) ?? 0) + 1);
  }
  return counts;
}

function mapsEqual<K>(a: Map<K, number>, b: Map<K, number>): boolean {
  if (a.size !== b.size) return false;
  for (const [key, value] of a.entries()) {
    if ((b.get(key) ?? 0) !== value) return false;
  }
  return true;
}

function numericTokensChanged(quote: string, content: string): boolean {
  const quoteTokens = extractNumericTokens(quote).map((t) => t.raw);
  const contentTokens = extractNumericTokens(content).map((t) => t.raw);
  if (quoteTokens.length !== contentTokens.length) return true;
  for (let i = 0; i < quoteTokens.length; i += 1) {
    if (quoteTokens[i] !== contentTokens[i]) return true;
  }
  return false;
}

function numberWordCountsChanged(quote: string, content: string): boolean {
  const quoteCounts = extractNumberWordCounts(quote);
  const contentCounts = extractNumberWordCounts(content);
  return !mapsEqual(quoteCounts, contentCounts);
}

function validateFocusAreaContext(proposal: SubAgentProposal): string | null {
  const focusAreaName = proposal.focusAreaName;
  const change = proposal.change;
  if (!focusAreaName || !change?.quote) return null;

  if (focusAreaMatches(focusAreaName, ['caption']) && !isItalicizedQuote(change.quote)) {
    return 'caption_requires_italics';
  }

  if (focusAreaMatches(focusAreaName, ['headline', 'title case']) && !isHedOrH1Quote(change.quote)) {
    return 'headline_requires_hed_or_h1';
  }

  if (focusAreaMatches(focusAreaName, ['job title']) && !containsJobTitleKeyword(change.quote)) {
    return 'job_title_keyword_missing';
  }

  if (focusAreaIsHeadingConversion(proposal) && change.kind === 'suggestion') {
    if (containsNewline(change.quote) && !multilineQuoteIsHeadingLabels(change.quote)) {
      return 'heading_multiline_non_heading';
    }
    if (!isStandaloneHeadingLikeLine(change.quote)) {
      return 'heading_not_standalone';
    }
  }

  if (focusAreaIsNumberFormatting(proposal) && change.kind === 'suggestion' && change.suggestionType === 'replace') {
    const content = change.content ?? '';
    const hasNumericChange = numericTokensChanged(change.quote, content) || numberWordCountsChanged(change.quote, content);
    if (!hasNumericChange) {
      return 'number_focus_no_numeric_change';
    }
  }

  return null;
}

const COMMON_ABBREVIATIONS = new Set<string>(['AI', 'CMS', 'DVD', 'FTP', 'TV', 'UK', 'UN']);
const NUMERIC_TOKEN_PATTERN = /-?\d[\d,]*(?:\.\d+)?/g;
const PERCENT_VALUE_PATTERN = /(-?\d[\d,]*(?:\.\d+)?)\s*percent\b/gi;

interface NumericToken {
  raw: string;
  value: number;
  index: number;
}

function parseNumericValue(raw: string): number | null {
  const normalized = raw.replace(/,/g, '');
  const value = Number(normalized);
  return Number.isFinite(value) ? value : null;
}

function extractNumericTokens(text: string): NumericToken[] {
  const tokens: NumericToken[] = [];
  const pattern = new RegExp(NUMERIC_TOKEN_PATTERN);
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    const raw = match[0] ?? '';
    const value = parseNumericValue(raw);
    if (value === null) continue;
    tokens.push({ raw, value, index: match.index });
  }
  return tokens;
}

function buildValueCounts(tokens: NumericToken[], minValue: number): Map<number, number> {
  const counts = new Map<number, number>();
  for (const token of tokens) {
    if (token.value < minValue) continue;
    counts.set(token.value, (counts.get(token.value) ?? 0) + 1);
  }
  return counts;
}

function decrementCount(counts: Map<number, number>, value: number): void {
  const current = counts.get(value);
  if (!current) return;
  if (current <= 1) {
    counts.delete(value);
    return;
  }
  counts.set(value, current - 1);
}

function hasMissingValues(required: Map<number, number>, available: Map<number, number>): boolean {
  for (const [value, requiredCount] of required.entries()) {
    const availableCount = available.get(value) ?? 0;
    if (availableCount < requiredCount) return true;
  }
  return false;
}

function isYearLikeToken(token: NumericToken | undefined): boolean {
  if (!token) return false;
  const normalizedRaw = token.raw.replace(/,/g, '');
  if (normalizedRaw.length !== 4) return false;
  return token.value >= 1000 && token.value <= 2999;
}

function isTokenAtQuoteStart(quote: string, token: NumericToken | undefined): boolean {
  if (!token) return false;
  const prefix = quote.slice(0, token.index).trim();
  if (!prefix) return true;
  return /^[("'\\[]+$/.test(prefix);
}

function extractPercentValueCounts(text: string): Map<number, number> {
  const counts = new Map<number, number>();
  const pattern = new RegExp(PERCENT_VALUE_PATTERN);
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    const raw = match[1] ?? '';
    const value = parseNumericValue(raw);
    if (value === null) continue;
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return counts;
}

function dropsLargeTrailingContent(quote: string, content: string): boolean {
  const normalizedQuote = normalizeWhitespace(quote);
  const normalizedContent = normalizeWhitespace(content);
  if (!normalizedQuote || !normalizedContent) return false;
  if (!normalizedQuote.startsWith(normalizedContent)) return false;

  const trailing = normalizedQuote.slice(normalizedContent.length).trim();
  if (trailing.length < 20) return false;
  if (!/[A-Za-z]/.test(trailing)) return false;
  if (!/\s/.test(trailing)) return false;
  return true;
}

function removesTenPlusNumeralsWithoutDigits(quote: string, content: string): boolean {
  const numericTokens = extractNumericTokens(quote);
  if (numericTokens.length === 0) return false;

  const requiredCounts = buildValueCounts(numericTokens, 10);
  if (requiredCounts.size === 0) return false;

  // Allow spelling out a leading non-year number at the start of the quote (e.g., "12 ways" -> "Twelve ways").
  const firstToken = numericTokens[0];
  if (firstToken && !isYearLikeToken(firstToken) && isTokenAtQuoteStart(quote, firstToken)) {
    decrementCount(requiredCounts, firstToken.value);
    if (requiredCounts.size === 0) return false;
  }

  const availableCounts = buildValueCounts(extractNumericTokens(content), 10);
  return hasMissingValues(requiredCounts, availableCounts);
}

function removesPercentNumeral(quote: string, content: string): boolean {
  const requiredCounts = extractPercentValueCounts(quote);
  if (requiredCounts.size === 0) return false;
  const availableCounts = extractPercentValueCounts(content);
  return hasMissingValues(requiredCounts, availableCounts);
}

function expandsCommonAbbreviation(quote: string, content: string): boolean {
  const upperQuote = quote.toUpperCase();
  const upperContent = content.toUpperCase();
  for (const abbreviation of COMMON_ABBREVIATIONS) {
    const pattern = new RegExp(`\\b${abbreviation}\\b`);
    if (!pattern.test(upperQuote)) continue;
    if (upperContent.includes(`(${abbreviation})`)) {
      return true;
    }
  }
  return false;
}

export function quoteExistsInDocument(quote: string, normalizedDocument: string): boolean {
  const normalizedQuote = normalizeWhitespace(quote);
  if (!normalizedQuote) return false;
  if (!normalizedDocument) return false;
  return normalizedDocument.includes(normalizedQuote);
}

function countOccurrences(haystack: string, needle: string): number {
  if (!haystack || !needle) return 0;
  let count = 0;
  let index = 0;
  while (true) {
    const foundIndex = haystack.indexOf(needle, index);
    if (foundIndex === -1) break;
    count += 1;
    index = foundIndex + needle.length;
  }
  return count;
}

function commonPrefixLengthInsensitive(a: string, b: string): number {
  const aLower = a.toLowerCase();
  const bLower = b.toLowerCase();
  const limit = Math.min(aLower.length, bLower.length);
  let index = 0;
  while (index < limit && aLower[index] === bLower[index]) {
    index += 1;
  }
  return index;
}

function stripLeadingPunctuation(value: string): string {
  return value.replace(/^[\s"'“”‘’`.,;:!?…—–-]+/, '');
}

function hasSignificantFollowingOverlap(followingDocLower: string, contentTailLower: string): boolean {
  const docStripped = stripLeadingPunctuation(followingDocLower);
  const tailStripped = stripLeadingPunctuation(contentTailLower);
  if (!docStripped || !tailStripped) return false;

  const overlapLength = commonPrefixLengthInsensitive(docStripped, tailStripped);
  if (overlapLength < 8) return false;

  const overlapText = tailStripped.slice(0, overlapLength);
  const overlapWords = overlapText.split(/\s+/).filter(Boolean).length;
  return overlapLength >= 12 || overlapWords >= 3;
}

const SMALL_NUMBER_WORD_TO_DIGIT: Record<string, string> = {
  one: '1',
  two: '2',
  three: '3',
  four: '4',
  five: '5',
  six: '6',
  seven: '7',
  eight: '8',
  nine: '9',
};

const OVERUSED_WORDS = ['actually', 'very', 'just'] as const;
const COLON_INDEPENDENT_CLAUSE_STARTERS = new Set([
  'i',
  'you',
  'he',
  'she',
  'we',
  'they',
  'it',
  'this',
  'that',
  'these',
  'those',
]);

function hasAllowedSmallNumberDigitContext(text: string): boolean {
  const lower = text.toLowerCase();
  return /\b(percent|percentage|chapter|chap\.|section|sec\.)\b/.test(lower)
    || /\b(year-old|years old|year old)\b/.test(lower)
    || /[%$£€¥₹]/.test(text)
    || /\b(mph|km|mi|kg|lb|lbs|°|º|degrees?|cm|mm|m|ft|in|hrs?|hours?|mins?|minutes?|am|pm|a\.m\.|p\.m\.)\b/i.test(text);
}

function convertsSmallNumberWordToDigit(quote: string, content: string): boolean {
  if (!quote || !content) return false;
  if (hasAllowedSmallNumberDigitContext(quote) || hasAllowedSmallNumberDigitContext(content)) {
    return false;
  }
  const quoteLower = quote.toLowerCase();
  const contentLower = content.toLowerCase();
  for (const [word, digit] of Object.entries(SMALL_NUMBER_WORD_TO_DIGIT)) {
    const wordPattern = new RegExp(`\\b${word}\\b`, 'i');
    const digitPattern = new RegExp(`\\b${digit}\\b`);
    if (wordPattern.test(quoteLower) && digitPattern.test(contentLower)) {
      return true;
    }
  }
  return false;
}

function removesSingleWordExactly(quote: string, content: string, word: string): boolean {
  if (!quote || !content) return false;
  const wordPattern = new RegExp(`\\b${word}\\b`, 'i');
  if (!wordPattern.test(quote)) return false;
  const removed = normalizeWhitespace(quote.replace(wordPattern, ' '));
  const normalizedContent = normalizeWhitespace(content);
  return Boolean(removed) && removed === normalizedContent;
}

function isCommaParenthetical(word: string, quote: string): boolean {
  const commaWrapped = new RegExp(`,\\s*${word}\\s*,`, 'i');
  const startsWithComma = new RegExp(`^\\s*${word}\\s*,`, 'i');
  const parenWrapped = new RegExp(`\\(\\s*${word}\\s*\\)`, 'i');
  return commaWrapped.test(quote) || startsWithComma.test(quote) || parenWrapped.test(quote);
}

function removesOverusedWordUnsafely(quote: string, content: string): boolean {
  for (const word of OVERUSED_WORDS) {
    if (!removesSingleWordExactly(quote, content, word)) continue;
    // Be conservative: only allow deletion when the word is clearly parenthetical.
    if (!isCommaParenthetical(word, quote)) {
      return true;
    }
  }
  return false;
}

function isColonCaseLoweringLikelyIndependentClause(quote: string, content: string): boolean {
  if (!quote.includes(':') || !content.includes(':')) return false;
  const quoteMatch = quote.match(/^(.*?:\s*)([A-Za-z][A-Za-z'’.-]*)([\s\S]*)$/);
  const contentMatch = content.match(/^(.*?:\s*)([A-Za-z][A-Za-z'’.-]*)([\s\S]*)$/);
  if (!quoteMatch || !contentMatch) return false;

  const [, quotePrefix, quoteWord, quoteRest] = quoteMatch;
  const [, contentPrefix, contentWord, contentRest] = contentMatch;
  if (normalizeWhitespace(quotePrefix) !== normalizeWhitespace(contentPrefix)) return false;

  const quoteWordLower = quoteWord.toLowerCase();
  if (!COLON_INDEPENDENT_CLAUSE_STARTERS.has(quoteWordLower)) return false;
  if (contentWord !== quoteWordLower) return false;

  const quoteRestNormalized = normalizeWhitespace(quoteRest).toLowerCase();
  const contentRestNormalized = normalizeWhitespace(contentRest).toLowerCase();
  return quoteRestNormalized === contentRestNormalized;
}

export function validateProposalBase(change: ProposedChange): string | null {
  const quote = normalizeWhitespace(change.quote);
  if (!quote) return 'quote_empty';

  if (change.kind === 'comment') {
    const text = normalizeWhitespace(change.text);
    if (!text) return 'comment_empty';
    if (commentAppearsNoIssue(text)) return 'comment_no_issue';
    return null;
  }

  if (change.suggestionType === 'delete') {
    if (isUnsafeDelete(change.quote)) return 'unsafe_delete';
    return null;
  }

  const content = normalizeWhitespace(change.content ?? '');
  if (!content) return 'content_empty';

  if (change.suggestionType === 'replace') {
    if (content === quote) return 'noop_replace';
    if (hasCommaBeforeEndPunctuation(change.content ?? '')) return 'comma_before_end_punctuation';
    if (isCaseOnlyLoweringAtStart(change.quote, change.content ?? '')) return 'case_lowering_sentence_start';
    if (reducesSentenceCount(change.quote, change.content ?? '')) return 'sentence_count_reduced';
    if (replacesNumericHyphenCompoundWithEnDash(change.quote, change.content ?? '')) return 'compound_hyphen_en_dash';
    if (isLargeRewrite(change.quote, change.content ?? '')) return 'large_rewrite';
    if (dropsLargeTrailingContent(change.quote, change.content ?? '')) return 'drops_trailing_content';
    if (removesTenPlusNumeralsWithoutDigits(change.quote, change.content ?? '')) return 'numeral_removed_10plus';
    if (removesPercentNumeral(change.quote, change.content ?? '')) return 'percent_requires_numeral';
    if (expandsCommonAbbreviation(change.quote, change.content ?? '')) return 'common_abbreviation_expansion';
    if (convertsSmallNumberWordToDigit(change.quote, change.content ?? '')) return 'small_number_word_to_digit';
    if (removesOverusedWordUnsafely(change.quote, change.content ?? '')) return 'overused_word_context';
    if (isColonCaseLoweringLikelyIndependentClause(change.quote, change.content ?? '')) return 'colon_independent_clause';
  }

  return null;
}

export function validateProposalAgainstDocument(
  change: ProposedChange,
  document: string,
  normalizedDocument?: string
): string | null {
  if (!document.trim()) return null;
  const normalizedDoc = normalizedDocument ?? normalizeWhitespace(document);
  if (!normalizedDoc) return null;

  if (!quoteExistsInDocument(change.quote, normalizedDoc)) {
    return 'quote_not_found';
  }

  if (change.kind !== 'suggestion' || change.suggestionType !== 'replace' || !change.content) {
    return null;
  }

  const normalizedQuote = normalizeWhitespace(change.quote);
  const normalizedContent = normalizeWhitespace(change.content);
  if (!normalizedQuote || !normalizedContent) return null;
  if (normalizedContent.length <= normalizedQuote.length) return null;

  const normalizedDocLower = normalizedDoc.toLowerCase();
  const normalizedQuoteLower = normalizedQuote.toLowerCase();
  const normalizedContentLower = normalizedContent.toLowerCase();

  const occurrenceCount = countOccurrences(normalizedDocLower, normalizedQuoteLower);
  if (occurrenceCount !== 1) return null;

  const index = normalizedDocLower.indexOf(normalizedQuoteLower);
  if (index === -1) return null;

  const isAlphaNum = (char: string | undefined): boolean => Boolean(char && /[a-z0-9]/i.test(char));
  const quoteStartChar = normalizedQuoteLower[0];
  const quoteEndChar = normalizedQuoteLower[normalizedQuoteLower.length - 1];
  const beforeChar = normalizedDocLower[index - 1];
  const afterChar = normalizedDocLower[index + normalizedQuoteLower.length];
  if (isAlphaNum(quoteStartChar) && isAlphaNum(beforeChar)) {
    return 'quote_starts_mid_word';
  }
  if (isAlphaNum(quoteEndChar) && isAlphaNum(afterChar)) {
    return 'quote_ends_mid_word';
  }

  const prefixLength = commonPrefixLengthInsensitive(normalizedQuote, normalizedContent);
  if (prefixLength <= 0) return null;

  const remainderLower = normalizedContentLower.slice(prefixLength).trimStart();
  if (!remainderLower) return null;

  const followingDocLower = normalizedDocLower.slice(index + normalizedQuote.length).trimStart();
  if (followingDocLower.startsWith(remainderLower)) {
    return 'partial_quote_overlap';
  }
  if (hasSignificantFollowingOverlap(followingDocLower, remainderLower)) {
    return 'partial_quote_overlap_fuzzy';
  }

  return null;
}

function createProposalId(source: ProposalSource): string {
  const nonce = Math.random().toString(36).slice(2, 8);
  return `proposal-${source.focusAreaId}-${Date.now().toString(36)}-${nonce}`;
}

function cloneCounts(counts: ProposalCounts): ProposalCounts {
  return {
    total: counts.total,
    suggestions: counts.suggestions,
    comments: counts.comments,
  };
}

export function createProposalCollector(options: CreateProposalCollectorOptions): ProposalCollector {
  const { source } = options;
  const maxProposals = typeof options.maxProposals === 'number' && Number.isFinite(options.maxProposals)
    ? Math.max(1, Math.floor(options.maxProposals))
    : DEFAULT_MAX_PROPOSALS_PER_AGENT;

  const proposals: SubAgentProposal[] = [];
  const seenKeys = new Set<string>();
  const counts: ProposalCounts = { total: 0, suggestions: 0, comments: 0 };

  return {
    add(change: ProposedChange, meta?: ProposalAddMeta): ProposalAddResult {
      const invalidReason = validateProposalBase(change);
      if (invalidReason) {
        return {
          success: true,
          accepted: false,
          reason: `invalid:${invalidReason}`,
          counts: cloneCounts(counts),
        };
      }

      const key = buildChangeKey(change);
      if (seenKeys.has(key)) {
        return {
          success: true,
          accepted: false,
          reason: 'duplicate',
          counts: cloneCounts(counts),
        };
      }

      if (counts.total >= maxProposals) {
        return {
          success: true,
          accepted: false,
          reason: `limit_reached:${maxProposals}`,
          counts: cloneCounts(counts),
        };
      }

      const proposal: SubAgentProposal = {
        ...source,
        id: createProposalId(source),
        createdAt: Date.now(),
        change,
        markId: meta?.markId,
      };

      proposals.push(proposal);
      seenKeys.add(key);
      counts.total += 1;
      if (change.kind === 'suggestion') {
        counts.suggestions += 1;
      } else {
        counts.comments += 1;
      }

      return {
        success: true,
        accepted: true,
        id: proposal.id,
        markId: proposal.markId,
        counts: cloneCounts(counts),
      };
    },
    list(): SubAgentProposal[] {
      return proposals.slice();
    },
    counts(): ProposalCounts {
      return cloneCounts(counts);
    },
  };
}

export function dedupeProposals(
  proposals: SubAgentProposal[],
  document: string,
  maxProposals: number = DEFAULT_MAX_PROPOSALS_FOR_SYNTHESIS
): DedupedProposalResult {
  const limit = typeof maxProposals === 'number' && Number.isFinite(maxProposals)
    ? Math.max(1, Math.floor(maxProposals))
    : DEFAULT_MAX_PROPOSALS_FOR_SYNTHESIS;
  const normalizedDocument = normalizeWhitespace(document);
  const deduped: SubAgentProposal[] = [];
  const seen = new Set<string>();
  let duplicatesRemoved = 0;
  let invalidRemoved = 0;
  const invalidReasons: Record<string, number> = {};

  for (const proposal of proposals) {
    const normalizedChange = normalizeProposedChange(proposal.change);
    const normalizedProposal = normalizedChange === proposal.change
      ? proposal
      : { ...proposal, change: normalizedChange };

    const invalidReason = validateProposalBase(normalizedProposal.change);
    if (invalidReason) {
      invalidRemoved += 1;
      incrementReason(invalidReasons, invalidReason);
      continue;
    }

    const focusAreaInvalidReason = validateFocusAreaContext(normalizedProposal);
    if (focusAreaInvalidReason) {
      invalidRemoved += 1;
      incrementReason(invalidReasons, focusAreaInvalidReason);
      continue;
    }

    if (!quoteExistsInDocument(normalizedProposal.change.quote, normalizedDocument)) {
      invalidRemoved += 1;
      incrementReason(invalidReasons, 'quote_not_found');
      continue;
    }

    const documentInvalidReason = validateProposalAgainstDocument(
      normalizedProposal.change,
      document,
      normalizedDocument
    );
    if (documentInvalidReason) {
      invalidRemoved += 1;
      incrementReason(invalidReasons, documentInvalidReason);
      continue;
    }

    const change = normalizedProposal.change;
    const focusAreaNameLower = normalizedProposal.focusAreaName.toLowerCase();
    if (change.kind === 'suggestion' && change.suggestionType === 'replace' && change.content) {
      if (hasPrefixMismatchLargeReplace(change.quote, change.content)) {
        invalidRemoved += 1;
        incrementReason(invalidReasons, 'replace_prefix_mismatch');
        continue;
      }

      const headingTitle = extractHeadingTitle(change.content);
      if (headingTitle && documentHasHeading(headingTitle, document)) {
        invalidRemoved += 1;
        incrementReason(invalidReasons, 'heading_already_present');
        continue;
      }

      if (capitalizesYesNoAfterColon(change.quote, change.content)) {
        invalidRemoved += 1;
        incrementReason(invalidReasons, 'colon_yes_no_capitalization');
        continue;
      }

      if (focusAreaNameLower.includes('colon') && capitalizesAfterColonLikelyIncorrect(change.quote, change.content, document)) {
        invalidRemoved += 1;
        incrementReason(invalidReasons, 'colon_capitalization_sentence');
        continue;
      }

      if ((focusAreaNameLower.includes('serial') || focusAreaNameLower.includes('oxford'))
        && serialCommaOvercorrection(change.quote, change.content)) {
        invalidRemoved += 1;
        incrementReason(invalidReasons, 'serial_comma_overcorrection');
        continue;
      }

      if (documentHasHeading(change.quote, document) && isSignificantLowercasing(change.quote, change.content)) {
        invalidRemoved += 1;
        incrementReason(invalidReasons, 'heading_case_lowering');
        continue;
      }

      if (isHedOrDekQuote(change.quote) && isSignificantLowercasing(change.quote, change.content)) {
        invalidRemoved += 1;
        incrementReason(invalidReasons, 'hed_case_lowering');
        continue;
      }
    }

    const key = buildChangeKey(change);
    if (seen.has(key)) {
      duplicatesRemoved += 1;
      continue;
    }
    seen.add(key);
    deduped.push(normalizedProposal);
    if (deduped.length >= limit) {
      const truncated = proposals.length - deduped.length - duplicatesRemoved - invalidRemoved;
      return {
        proposals: deduped,
        duplicatesRemoved,
        truncated: Math.max(0, truncated),
        invalidRemoved,
        invalidReasons,
      };
    }
  }

  return {
    proposals: deduped,
    duplicatesRemoved,
    truncated: 0,
    invalidRemoved,
    invalidReasons,
  };
}
