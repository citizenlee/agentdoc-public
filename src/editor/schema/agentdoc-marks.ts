/**
 * Agentdoc Mark Schemas
 *
 * Anchors for suggestions, comments, review marks, and authored marks.
 * Serialized as inline HTML spans with data-agentdoc attributes (reads data-proof for backward compat).
 */

import { $markSchema, $markAttr } from '@milkdown/kit/utils';
import type { Attrs } from '@milkdown/kit/prose/model';

type AgentdocSuggestionKind = 'insert' | 'delete' | 'replace';

type AgentdocNode = {
  type?: string;
  markKind?: string;
  attrs?: Record<string, string | null | undefined>;
  children?: unknown[];
};

function normalizeSuggestionKind(kind: string | null | undefined): AgentdocSuggestionKind {
  if (kind === 'insert' || kind === 'delete' || kind === 'replace') return kind;
  return 'replace';
}

function parseCommonAttrs(dom: HTMLElement): { id: string | null; by: string } {
  return {
    id: dom.getAttribute('data-id'),
    by: dom.getAttribute('data-by') || 'unknown',
  };
}

function parseBooleanAttr(value: string | null): boolean | null {
  if (value === null) return null;
  if (value === 'true') return true;
  if (value === 'false') return false;
  return null;
}

function buildCommonDomAttrs(mark: { attrs: { id?: string | null; by?: string | null } }): Record<string, string> {
  const attrs: Record<string, string> = {};
  if (mark.attrs.id) attrs['data-id'] = mark.attrs.id;
  if (mark.attrs.by) attrs['data-by'] = mark.attrs.by;
  return attrs;
}

function serializeAgentdocMark(
  state: { withMark: (mark: unknown, type: string, value?: string, props?: Record<string, unknown>) => void },
  mark: { attrs: Record<string, string | null | undefined> },
  markKind: string,
  attrs: Record<string, string | null | undefined>
): void {
  state.withMark(mark, 'agentdocMark', undefined, { markKind, attrs });
}

// Suggestion mark
export const agentdocSuggestionAttr = $markAttr('agentdocSuggestion', () => ({
  id: {},
  kind: {},
  by: {},
}));

export const agentdocSuggestionSchema = $markSchema('agentdocSuggestion', (ctx) => ({
  attrs: {
    id: { default: null },
    kind: { default: 'replace' },
    by: { default: 'unknown' },
    content: { default: null },
    status: { default: null },
    createdAt: { default: null },
    runId: { default: null },
    focusAreaId: { default: null },
    focusAreaName: { default: null },
    agentId: { default: null },
    proposalId: { default: null },
    provisional: { default: null },
    orchestrator: { default: null },
    debugAutoFixedQuotes: { default: null },
    debugAutoFixedQuotesReason: { default: null },
  },
  inclusive: false,
  spanning: true,
  parseDOM: [
    {
      tag: 'span[data-agentdoc="suggestion"]',
      getAttrs: (dom: HTMLElement): Attrs => {
        const attrs = parseCommonAttrs(dom);
        const provisional = parseBooleanAttr(dom.getAttribute('data-provisional'));
        const orchestrator = parseBooleanAttr(dom.getAttribute('data-orchestrator'));
        const debugAutoFixedQuotes = parseBooleanAttr(dom.getAttribute('data-debug-autofixed-quotes'));
        return {
          ...attrs,
          kind: normalizeSuggestionKind(dom.getAttribute('data-kind')),
          content: dom.getAttribute('data-content'),
          status: dom.getAttribute('data-status'),
          createdAt: dom.getAttribute('data-created-at'),
          runId: dom.getAttribute('data-run-id'),
          focusAreaId: dom.getAttribute('data-focus-area-id'),
          focusAreaName: dom.getAttribute('data-focus-area-name'),
          agentId: dom.getAttribute('data-agent-id'),
          proposalId: dom.getAttribute('data-proposal-id'),
          provisional: provisional ?? null,
          orchestrator: orchestrator ?? null,
          debugAutoFixedQuotes: debugAutoFixedQuotes ?? null,
          debugAutoFixedQuotesReason: dom.getAttribute('data-debug-autofixed-quotes-reason'),
        };
      },
    },
    {
      tag: 'span[data-proof="suggestion"]',
      getAttrs: (dom: HTMLElement): Attrs => {
        const attrs = parseCommonAttrs(dom);
        const provisional = parseBooleanAttr(dom.getAttribute('data-provisional'));
        const orchestrator = parseBooleanAttr(dom.getAttribute('data-orchestrator'));
        const debugAutoFixedQuotes = parseBooleanAttr(dom.getAttribute('data-debug-autofixed-quotes'));
        return {
          ...attrs,
          kind: normalizeSuggestionKind(dom.getAttribute('data-kind')),
          content: dom.getAttribute('data-content'),
          status: dom.getAttribute('data-status'),
          createdAt: dom.getAttribute('data-created-at'),
          runId: dom.getAttribute('data-run-id'),
          focusAreaId: dom.getAttribute('data-focus-area-id'),
          focusAreaName: dom.getAttribute('data-focus-area-name'),
          agentId: dom.getAttribute('data-agent-id'),
          proposalId: dom.getAttribute('data-proposal-id'),
          provisional: provisional ?? null,
          orchestrator: orchestrator ?? null,
          debugAutoFixedQuotes: debugAutoFixedQuotes ?? null,
          debugAutoFixedQuotesReason: dom.getAttribute('data-debug-autofixed-quotes-reason'),
        };
      },
    },
  ],
  toDOM: (mark) => {
    const attrs = ctx.get(agentdocSuggestionAttr.key)(mark);
    const domAttrs: Record<string, string> = {
      'data-agentdoc': 'suggestion',
      'data-kind': normalizeSuggestionKind(mark.attrs.kind),
      ...buildCommonDomAttrs(mark),
      ...attrs,
    };
    if (mark.attrs.content) domAttrs['data-content'] = String(mark.attrs.content);
    if (mark.attrs.status) domAttrs['data-status'] = String(mark.attrs.status);
    if (mark.attrs.createdAt) domAttrs['data-created-at'] = String(mark.attrs.createdAt);
    if (mark.attrs.runId) domAttrs['data-run-id'] = String(mark.attrs.runId);
    if (mark.attrs.focusAreaId) domAttrs['data-focus-area-id'] = String(mark.attrs.focusAreaId);
    if (mark.attrs.focusAreaName) domAttrs['data-focus-area-name'] = String(mark.attrs.focusAreaName);
    if (mark.attrs.agentId) domAttrs['data-agent-id'] = String(mark.attrs.agentId);
    if (mark.attrs.proposalId) domAttrs['data-proposal-id'] = String(mark.attrs.proposalId);
    if (typeof mark.attrs.provisional === 'boolean') {
      domAttrs['data-provisional'] = String(mark.attrs.provisional);
    }
    if (typeof mark.attrs.orchestrator === 'boolean') {
      domAttrs['data-orchestrator'] = String(mark.attrs.orchestrator);
    }
    if (typeof mark.attrs.debugAutoFixedQuotes === 'boolean') {
      domAttrs['data-debug-autofixed-quotes'] = String(mark.attrs.debugAutoFixedQuotes);
    }
    if (mark.attrs.debugAutoFixedQuotesReason) {
      domAttrs['data-debug-autofixed-quotes-reason'] = String(mark.attrs.debugAutoFixedQuotesReason);
    }
    return ['span', domAttrs, 0];
  },
  parseMarkdown: {
    match: (node) => (node as AgentdocNode).type === 'agentdocMark' && (node as AgentdocNode).markKind === 'suggestion',
    runner: (state, node, markType) => {
      const agentdocNode = node as AgentdocNode;
      const attrs = agentdocNode.attrs || {};
      const provisional = parseBooleanAttr(attrs.provisional ?? null);
      const orchestrator = parseBooleanAttr(attrs.orchestrator ?? null);
      state.openMark(markType, {
        id: attrs.id ?? null,
        kind: normalizeSuggestionKind(attrs.kind),
        by: attrs.by ?? 'unknown',
        content: attrs.content ?? null,
        status: attrs.status ?? null,
        createdAt: attrs.createdAt ?? null,
        runId: attrs.runId ?? null,
        focusAreaId: attrs.focusAreaId ?? null,
        focusAreaName: attrs.focusAreaName ?? null,
        agentId: attrs.agentId ?? null,
        proposalId: attrs.proposalId ?? null,
        provisional: provisional ?? null,
        orchestrator: orchestrator ?? null,
      });
      state.next(agentdocNode.children || []);
      state.closeMark(markType);
    },
  },
  toMarkdown: {
    match: (mark) => mark.type.name === 'agentdocSuggestion',
    runner: (state, mark) => {
      serializeAgentdocMark(state, mark, 'suggestion', {
        id: mark.attrs.id ?? null,
        by: mark.attrs.by ?? null,
        kind: normalizeSuggestionKind(mark.attrs.kind),
      });
    },
  },
}));

// Comment mark
export const agentdocCommentAttr = $markAttr('agentdocComment', () => ({
  id: {},
  by: {},
}));

export const agentdocCommentSchema = $markSchema('agentdocComment', (ctx) => ({
  attrs: {
    id: { default: null },
    by: { default: 'unknown' },
  },
  inclusive: false,
  spanning: true,
  parseDOM: [
    {
      tag: 'span[data-agentdoc="comment"]',
      getAttrs: (dom: HTMLElement): Attrs => parseCommonAttrs(dom),
    },
    {
      tag: 'span[data-proof="comment"]',
      getAttrs: (dom: HTMLElement): Attrs => parseCommonAttrs(dom),
    },
  ],
  toDOM: (mark) => {
    const attrs = ctx.get(agentdocCommentAttr.key)(mark);
    const domAttrs: Record<string, string> = {
      'data-agentdoc': 'comment',
      ...buildCommonDomAttrs(mark),
      ...attrs,
    };
    return ['span', domAttrs, 0];
  },
  parseMarkdown: {
    match: (node) => (node as AgentdocNode).type === 'agentdocMark' && (node as AgentdocNode).markKind === 'comment',
    runner: (state, node, markType) => {
      const agentdocNode = node as AgentdocNode;
      const attrs = agentdocNode.attrs || {};
      state.openMark(markType, {
        id: attrs.id ?? null,
        by: attrs.by ?? 'unknown',
      });
      state.next(agentdocNode.children || []);
      state.closeMark(markType);
    },
  },
  toMarkdown: {
    match: (mark) => mark.type.name === 'agentdocComment',
    runner: (state, mark) => {
      serializeAgentdocMark(state, mark, 'comment', {
        id: mark.attrs.id ?? null,
        by: mark.attrs.by ?? null,
      });
    },
  },
}));

// Flagged mark
export const agentdocFlaggedAttr = $markAttr('agentdocFlagged', () => ({
  id: {},
  by: {},
}));

export const agentdocFlaggedSchema = $markSchema('agentdocFlagged', (ctx) => ({
  attrs: {
    id: { default: null },
    by: { default: 'unknown' },
  },
  inclusive: false,
  spanning: true,
  parseDOM: [
    {
      tag: 'span[data-agentdoc="flagged"]',
      getAttrs: (dom: HTMLElement): Attrs => parseCommonAttrs(dom),
    },
    {
      tag: 'span[data-proof="flagged"]',
      getAttrs: (dom: HTMLElement): Attrs => parseCommonAttrs(dom),
    },
  ],
  toDOM: (mark) => {
    const attrs = ctx.get(agentdocFlaggedAttr.key)(mark);
    const domAttrs: Record<string, string> = {
      'data-agentdoc': 'flagged',
      ...buildCommonDomAttrs(mark),
      ...attrs,
    };
    return ['span', domAttrs, 0];
  },
  parseMarkdown: {
    match: (node) => (node as AgentdocNode).type === 'agentdocMark' && (node as AgentdocNode).markKind === 'flagged',
    runner: (state, node, markType) => {
      const agentdocNode = node as AgentdocNode;
      const attrs = agentdocNode.attrs || {};
      state.openMark(markType, {
        id: attrs.id ?? null,
        by: attrs.by ?? 'unknown',
      });
      state.next(agentdocNode.children || []);
      state.closeMark(markType);
    },
  },
  toMarkdown: {
    match: (mark) => mark.type.name === 'agentdocFlagged',
    runner: (state, mark) => {
      serializeAgentdocMark(state, mark, 'flagged', {
        id: mark.attrs.id ?? null,
        by: mark.attrs.by ?? null,
      });
    },
  },
}));

// Approved mark
export const agentdocApprovedAttr = $markAttr('agentdocApproved', () => ({
  id: {},
  by: {},
}));

export const agentdocApprovedSchema = $markSchema('agentdocApproved', (ctx) => ({
  attrs: {
    id: { default: null },
    by: { default: 'unknown' },
  },
  inclusive: false,
  spanning: true,
  parseDOM: [
    {
      tag: 'span[data-agentdoc="approved"]',
      getAttrs: (dom: HTMLElement): Attrs => parseCommonAttrs(dom),
    },
    {
      tag: 'span[data-proof="approved"]',
      getAttrs: (dom: HTMLElement): Attrs => parseCommonAttrs(dom),
    },
  ],
  toDOM: (mark) => {
    const attrs = ctx.get(agentdocApprovedAttr.key)(mark);
    const domAttrs: Record<string, string> = {
      'data-agentdoc': 'approved',
      ...buildCommonDomAttrs(mark),
      ...attrs,
    };
    return ['span', domAttrs, 0];
  },
  parseMarkdown: {
    match: (node) => (node as AgentdocNode).type === 'agentdocMark' && (node as AgentdocNode).markKind === 'approved',
    runner: (state, node, markType) => {
      const agentdocNode = node as AgentdocNode;
      const attrs = agentdocNode.attrs || {};
      state.openMark(markType, {
        id: attrs.id ?? null,
        by: attrs.by ?? 'unknown',
      });
      state.next(agentdocNode.children || []);
      state.closeMark(markType);
    },
  },
  toMarkdown: {
    match: (mark) => mark.type.name === 'agentdocApproved',
    runner: (state, mark) => {
      serializeAgentdocMark(state, mark, 'approved', {
        id: mark.attrs.id ?? null,
        by: mark.attrs.by ?? null,
      });
    },
  },
}));

// Authored mark
export const agentdocAuthoredAttr = $markAttr('agentdocAuthored', () => ({
  by: {},
  id: {},
}));

export const agentdocAuthoredSchema = $markSchema('agentdocAuthored', (ctx) => ({
  attrs: {
    by: { default: 'human:unknown' },
    id: { default: null },
  },
  inclusive: true,
  excludes: 'agentdocAuthored',
  spanning: true,
  parseDOM: [
    {
      tag: 'span[data-agentdoc="authored"]',
      getAttrs: (dom: HTMLElement): Attrs => ({
        by: dom.getAttribute('data-by') || 'human:unknown',
        id: dom.getAttribute('data-agentdoc-id') || dom.getAttribute('data-proof-id') || dom.getAttribute('data-id') || null,
      }),
    },
    {
      tag: 'span[data-proof="authored"]',
      getAttrs: (dom: HTMLElement): Attrs => ({
        by: dom.getAttribute('data-by') || 'human:unknown',
        id: dom.getAttribute('data-proof-id') || dom.getAttribute('data-agentdoc-id') || dom.getAttribute('data-id') || null,
      }),
    },
  ],
  toDOM: (mark) => {
    const attrs = ctx.get(agentdocAuthoredAttr.key)(mark);
    return [
      'span',
      {
        'data-agentdoc': 'authored',
        'data-by': mark.attrs.by,
        'data-agentdoc-id': mark.attrs.id ?? null,
        ...attrs,
      },
      0,
    ];
  },
  parseMarkdown: {
    match: (node) => (node as AgentdocNode).type === 'agentdocMark' && (node as AgentdocNode).markKind === 'authored',
    runner: (state, node, markType) => {
      const agentdocNode = node as AgentdocNode;
      const attrs = agentdocNode.attrs || {};
      state.openMark(markType, {
        by: attrs.by ?? 'human:unknown',
        id: attrs.id ?? null,
      });
      state.next(agentdocNode.children || []);
      state.closeMark(markType);
    },
  },
  toMarkdown: {
    match: (mark) => mark.type.name === 'agentdocAuthored',
    runner: (state, mark) => {
      serializeAgentdocMark(state, mark, 'authored', {
        by: mark.attrs.by ?? null,
        id: mark.attrs.id ?? null,
      });
    },
  },
}));

export const agentdocMarkPlugins = [
  agentdocSuggestionAttr,
  agentdocSuggestionSchema,
  agentdocCommentAttr,
  agentdocCommentSchema,
  agentdocFlaggedAttr,
  agentdocFlaggedSchema,
  agentdocApprovedAttr,
  agentdocApprovedSchema,
  agentdocAuthoredAttr,
  agentdocAuthoredSchema,
];
