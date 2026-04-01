export type BridgeMethod = 'GET' | 'POST';
export type BridgeAuthMode = 'none' | 'bridge-token';

const ORCHESTRATION_META_KEYS = [
  'runId',
  'focusAreaId',
  'focusAreaName',
  'agentId',
  'proposalId',
  'provisional',
  'orchestrator',
  'debugAutoFixedQuotes',
  'debugAutoFixedQuotesReason',
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseRange(value: unknown): { from: number; to: number } | undefined {
  if (!isRecord(value)) return undefined;
  const from = typeof value.from === 'number' ? value.from : Number.NaN;
  const to = typeof value.to === 'number' ? value.to : Number.NaN;
  if (!Number.isFinite(from) || !Number.isFinite(to)) return undefined;
  return { from, to };
}

function extractOrchestrationMeta(params: Record<string, unknown>): Record<string, unknown> | undefined {
  const meta: Record<string, unknown> = {};
  for (const key of ORCHESTRATION_META_KEYS) {
    const value = params[key];
    if (value !== undefined && value !== null) {
      meta[key] = value;
    }
  }
  return Object.keys(meta).length > 0 ? meta : undefined;
}

export interface BridgeExecutorAgentdoc {
  getState: () => unknown;
  getMarks: () => unknown[];
  markComment: (quote: string, by: string, text: string, meta?: Record<string, unknown>) => unknown | null;
  markCommentSelector?: (
    selector: Record<string, unknown>,
    by: string,
    text: string,
    meta?: Record<string, unknown>
  ) => unknown | null;
  markSuggestReplace: (
    quote: string,
    by: string,
    content: string,
    range?: { from: number; to: number },
    meta?: Record<string, unknown>
  ) => unknown | null;
  markSuggestInsert: (
    quote: string,
    by: string,
    content: string,
    range?: { from: number; to: number },
    meta?: Record<string, unknown>
  ) => unknown | null;
  markSuggestDelete: (
    quote: string,
    by: string,
    range?: { from: number; to: number },
    meta?: Record<string, unknown>
  ) => unknown | null;
  markAccept: (markId: string) => boolean;
  markReject: (markId: string) => boolean;
  markReply: (markId: string, by: string, text: string) => unknown | null;
  markResolve: (markId: string) => boolean;
  rewrite: (params: Record<string, unknown>) => unknown;
  setPresence: (payload: Record<string, unknown>) => unknown;
}

export interface BridgeRoute {
  method: BridgeMethod;
  path: string;
  required?: string[];
  auth: BridgeAuthMode;
  exec: (editor: BridgeExecutorAgentdoc, params: Record<string, unknown>) => unknown;
}

function quoteNotFoundResponse(path: string): Record<string, unknown> {
  return {
    success: false,
    code: 'quote_not_found',
    error: 'Quote not found in document',
    hint: 'The provided quote no longer matches the current markdown snapshot.',
    nextSteps: [
      'Fetch GET /state to refresh content.',
      'Use exact quote text from latest state or a selector or range.',
      `Retry POST ${path}.`,
    ],
  };
}

function executeCommentRoute(editor: BridgeExecutorAgentdoc, params: Record<string, unknown>): Record<string, unknown> {
  const by = params.by as string;
  const text = params.text as string;
  const selector = isRecord(params.selector) && Object.keys(params.selector).length > 0
    ? params.selector
    : null;
  const quote = typeof params.quote === 'string' ? params.quote : '';
  const meta = extractOrchestrationMeta(params);

  if (!selector && quote.length === 0) {
    return {
      success: false,
      code: 'validation_error',
      error: 'Missing required field: quote or selector',
      hint: 'Provide quote text or selector to anchor the comment.',
      nextSteps: [
        'Fetch /state to capture the latest content.',
        'Send quote or selector along with by/text.',
        'Retry POST /comments.',
      ],
    };
  }

  const mark = selector && typeof editor.markCommentSelector === 'function'
    ? editor.markCommentSelector(selector, by, text, meta)
    : editor.markComment(quote, by, text, meta);
  return { success: Boolean(mark), mark };
}

function executeSuggestionRoute(editor: BridgeExecutorAgentdoc, params: Record<string, unknown>): Record<string, unknown> {
  const kind = typeof params.kind === 'string' ? params.kind.trim().toLowerCase() : '';
  const quote = params.quote as string;
  const by = params.by as string;
  const range = parseRange(params.range);
  const meta = extractOrchestrationMeta(params);

  if (kind === 'replace') {
    if (typeof params.content !== 'string') {
      return { success: false, code: 'validation_error', error: 'replace suggestions require content' };
    }
    const mark = editor.markSuggestReplace(quote, by, params.content, range, meta);
    return mark ? { success: true, mark } : quoteNotFoundResponse('/suggestions');
  }

  if (kind === 'insert') {
    if (typeof params.content !== 'string') {
      return { success: false, code: 'validation_error', error: 'insert suggestions require content' };
    }
    const mark = editor.markSuggestInsert(quote, by, params.content, range, meta);
    return mark ? { success: true, mark } : quoteNotFoundResponse('/suggestions');
  }

  if (kind === 'delete') {
    const mark = editor.markSuggestDelete(quote, by, range, meta);
    return mark ? { success: true, mark } : quoteNotFoundResponse('/suggestions');
  }

  return {
    success: false,
    code: 'validation_error',
    error: 'kind must be one of insert, delete, or replace',
  };
}

export const bridgeRoutes: BridgeRoute[] = [
  {
    method: 'GET',
    path: '/state',
    auth: 'none',
    exec: (editor) => editor.getState(),
  },
  {
    method: 'GET',
    path: '/marks',
    auth: 'none',
    exec: (editor) => ({ success: true, marks: editor.getMarks() }),
  },
  {
    method: 'POST',
    path: '/marks/comment',
    required: ['by', 'text'],
    auth: 'none',
    exec: (editor, params) => executeCommentRoute(editor, params),
  },
  {
    method: 'POST',
    path: '/comments',
    required: ['by', 'text'],
    auth: 'none',
    exec: (editor, params) => executeCommentRoute(editor, params),
  },
  {
    method: 'POST',
    path: '/marks/suggest-replace',
    required: ['quote', 'by', 'content'],
    auth: 'none',
    exec: (editor, params) => {
      const range = parseRange(params.range);
      const meta = extractOrchestrationMeta(params);
      const mark = editor.markSuggestReplace(
        params.quote as string,
        params.by as string,
        params.content as string,
        range,
        meta
      );
      if (!mark) {
        return {
          success: false,
          code: 'quote_not_found',
          error: 'Quote not found in document',
          hint: 'The provided quote no longer matches the current markdown snapshot.',
          nextSteps: [
            'Fetch GET /state to refresh content.',
            'Use exact quote text from latest state or a selector/range.',
            'Retry POST /marks/suggest-replace.',
          ],
        };
      }
      return { success: true, mark };
    },
  },
  {
    method: 'POST',
    path: '/marks/suggest-insert',
    required: ['quote', 'by', 'content'],
    auth: 'none',
    exec: (editor, params) => {
      const range = parseRange(params.range);
      const meta = extractOrchestrationMeta(params);
      const mark = editor.markSuggestInsert(
        params.quote as string,
        params.by as string,
        params.content as string,
        range,
        meta
      );
      if (!mark) {
        return {
          success: false,
          code: 'quote_not_found',
          error: 'Quote not found in document',
          hint: 'The provided quote no longer matches the current markdown snapshot.',
          nextSteps: [
            'Fetch GET /state to refresh content.',
            'Use exact quote text from latest state or a selector/range.',
            'Retry POST /marks/suggest-insert.',
          ],
        };
      }
      return { success: true, mark };
    },
  },
  {
    method: 'POST',
    path: '/marks/suggest-delete',
    required: ['quote', 'by'],
    auth: 'none',
    exec: (editor, params) => {
      const range = parseRange(params.range);
      const meta = extractOrchestrationMeta(params);
      const mark = editor.markSuggestDelete(
        params.quote as string,
        params.by as string,
        range,
        meta
      );
      if (!mark) {
        return {
          success: false,
          code: 'quote_not_found',
          error: 'Quote not found in document',
          hint: 'The provided quote no longer matches the current markdown snapshot.',
          nextSteps: [
            'Fetch GET /state to refresh content.',
            'Use exact quote text from latest state or a selector/range.',
            'Retry POST /marks/suggest-delete.',
          ],
        };
      }
      return { success: true, mark };
    },
  },
  {
    method: 'POST',
    path: '/marks/accept',
    required: ['markId'],
    auth: 'bridge-token',
    exec: (editor, params) => ({ success: editor.markAccept(params.markId as string) }),
  },
  {
    method: 'POST',
    path: '/marks/reject',
    required: ['markId'],
    auth: 'bridge-token',
    exec: (editor, params) => ({ success: editor.markReject(params.markId as string) }),
  },
  {
    method: 'POST',
    path: '/marks/reply',
    required: ['markId', 'by', 'text'],
    auth: 'bridge-token',
    exec: (editor, params) => {
      const mark = editor.markReply(
        params.markId as string,
        params.by as string,
        params.text as string
      );
      return { success: Boolean(mark), mark };
    },
  },
  {
    method: 'POST',
    path: '/marks/resolve',
    required: ['markId'],
    auth: 'bridge-token',
    exec: (editor, params) => ({ success: editor.markResolve(params.markId as string) }),
  },
  {
    method: 'POST',
    path: '/comments/reply',
    required: ['markId', 'by', 'text'],
    auth: 'bridge-token',
    exec: (editor, params) => {
      const mark = editor.markReply(
        params.markId as string,
        params.by as string,
        params.text as string,
      );
      return { success: Boolean(mark), mark };
    },
  },
  {
    method: 'POST',
    path: '/comments/resolve',
    required: ['markId'],
    auth: 'bridge-token',
    exec: (editor, params) => ({ success: editor.markResolve(params.markId as string) }),
  },
  {
    method: 'POST',
    path: '/suggestions',
    required: ['kind', 'quote', 'by'],
    auth: 'none',
    exec: (editor, params) => executeSuggestionRoute(editor, params),
  },
  {
    method: 'POST',
    path: '/rewrite',
    auth: 'none',
    exec: (editor, params) => editor.rewrite(params),
  },
  {
    method: 'POST',
    path: '/presence',
    required: ['status'],
    auth: 'bridge-token',
    exec: (editor, params) => editor.setPresence(params),
  },
];

export function findBridgeRoute(method: string, path: string): BridgeRoute | undefined {
  const normalizedMethod = method.toUpperCase() as BridgeMethod;
  return bridgeRoutes.find((route) => route.method === normalizedMethod && route.path === path);
}
