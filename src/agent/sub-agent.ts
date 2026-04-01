import Anthropic from '@anthropic-ai/sdk';
import type {
  MessageParam,
  ContentBlockParam,
  ToolResultBlockParam,
  ToolUseBlock,
  TextBlock,
} from '@anthropic-ai/sdk/resources/messages';
import { getAgentConfig } from './config';
import type { FocusArea } from './orchestrator';
import { getHttpBridgeTools } from './tools/http-bridge-tools';
import type { AgentTool } from './types';
import { updateExternalAgentPresence, clearExternalAgentSession } from './external-agent-bridge';
import { createProposalCollector, type ProposalCounts, type SubAgentProposal } from './proposals';

export interface SubAgentStatusUpdate {
  focusAreaId: string;
  focusAreaName: string;
  agentId: string;
  status: 'running' | 'completed' | 'error' | 'cancelled';
  message?: string;
  suggestionCount?: number;
}

export interface SubAgentRunOptions {
  focusArea: FocusArea;
  agentId: string;
  actor: string;
  runId: string;
  markStrategy?: 'propose' | 'visible-provisional';
  singleWriter?: boolean;
  styleGuideContent?: string;
  documentContent?: string;
  signal?: AbortSignal;
  onStatus?: (update: SubAgentStatusUpdate) => void;
}

export interface SubAgentResult {
  agentId: string;
  focusAreaId: string;
  focusAreaName: string;
  status: 'completed' | 'error' | 'cancelled';
  suggestionCount: number;
  proposalCounts: ProposalCounts;
  proposals: SubAgentProposal[];
  toolCalls: number;
  error?: string;
  rawText?: string;
}

const DEFAULT_SUB_AGENT_MODEL = 'claude-haiku-4-5-20251001';
const SUB_AGENT_MAX_TOKENS = 4096;
const MAX_ITERATIONS = 100;
const MAX_CONSECUTIVE_NO_MATCH_SEARCHES = 10;
const MAX_TOOL_CALLS_WITHOUT_PROPOSALS = 60;
const MAX_TOOL_CALLS_TOTAL = 50;
const MAX_IDENTICAL_NO_MATCH_SEARCH_REPEATS = 3;
const MAX_CONSECUTIVE_REGEX_NO_MATCH_SEARCHES = 8;
const MIN_TOOL_CALLS_SINCE_PROPOSAL_GROWTH_FOR_BREAK = 16;
const REGEX_NO_MATCH_BUDGET_MAX = 3;
const MAX_SEARCH_DENIALS_AFTER_BUDGET_EXHAUSTED = 3;
const STYLE_REVIEW_SEARCH_CALLS_MAX_DEFAULT = 12;
const MAX_SCOPE_ENFORCEMENT_ERRORS_WITHOUT_PROGRESS = 3;
const MIN_TOOL_CALLS_SINCE_PROPOSAL_GROWTH_FOR_SCOPE_BREAK = 6;
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
const SUB_AGENT_MAX_RETRIES = 3;
const SUB_AGENT_RETRY_BASE_DELAY_MS = 2_000;
const SUB_AGENT_HEARTBEAT_MS = 30_000;
const PROPOSE_CHANGE_TOOL_CHOICE = { type: 'tool', name: 'propose_change' } as const;
const MAX_PRESENCE_SUMMARY_CHARS = 180;
const ORCHESTRATION_PROTOCOL = `You are part of an orchestrated review. Use propose_change for all suggestions and comments. propose_change does not create marks directly; the orchestrator owns preview marks, final mark creation, and conflict reconciliation. Do not accept, reject, or modify suggestions directly. If other instructions mention create_suggestion or add_comment, translate them into propose_change calls.

The full style guide and/or document may be provided below. If they are present, treat them as canonical and do not call read_style_guide() or read_document(), even if other instructions tell you to. If either is missing, call the corresponding tool once at the start. After you have the rules and document context, use search() to scan for concrete violations in your focus area.

Critical editorial rules that are easy to get wrong:
- Numbers: spell out one through nine; use numerals for 10+ and always use numerals for percentages and ages.
- Established abbreviations stay abbreviated: AI, CMS, DVD, FTP, TV, UK, and UN.
- Dashes and ranges: em dashes have no spaces around them, and numeric ranges should use en dashes. If your focus area touches dashes/ranges, explicitly search for "— ", " —", and the regex "\\d+-\\d+".
- Quotes must be exact and complete. Do not truncate quotes or include extra trailing sentences in a replace suggestion.

Base every proposal on actual document text and include exact quotes. Prefer small, surgical edits that change as little as possible. Structural edits are allowed when the style guide requires them (for example: headings, captions, and list formatting), but keep them tightly scoped. If a fix would require rewriting more than about 60 words, add a comment explaining the issue instead.

Do not keep searching indefinitely. After you have proposed the clearest violations you can find, stop. Aim to finish within about 30 tool calls and avoid repeated searches that return no new information.
If your prompt lists specific searches, run each of them once. If they return no matches, stop instead of inventing many new searches.

Never propose a replacement that is identical to the quote.`;

type SubAgentDebugStatus = SubAgentResult['status'] | 'running';

interface SubAgentDebugState {
  agentId: string;
  focusAreaId: string;
  focusAreaName: string;
  status: SubAgentDebugStatus;
  toolCalls: number;
  proposalCounts: ProposalCounts;
  candidateCount?: number;
  toolNames: string[];
  toolErrors: string[];
  searchCallsUsed?: number;
  searchCallsMax?: number | null;
  searchCallsRemaining?: number | null;
  regexNoMatchBudgetRemaining?: number;
  regexNoMatchBudgetExhausted?: boolean;
  searchDenialsAfterBudgetExhausted?: number;
  rawTextPreview: string;
  startedAt: number;
  finishedAt: number | null;
  error: string | null;
  lastUpdated: number;
}

const subAgentDebugStates = new Map<string, SubAgentDebugState>();

if (typeof window !== 'undefined') {
  (window as Window & {
    __agentdocSubAgentDebug?: {
      get: () => SubAgentDebugState[];
      getByAgentId: (agentId: string) => SubAgentDebugState | null;
    };
  }).__agentdocSubAgentDebug = {
    get: () => Array.from(subAgentDebugStates.values()),
    getByAgentId: (agentId: string) => subAgentDebugStates.get(agentId) ?? null,
  };
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new Error('Review cancelled');
  }
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export interface SubAgentTimingProfile {
  requestTimeoutMs: number;
  stallTimeoutMs: number;
  wallClockTimeoutMs: number;
}

const HAIKU_SUB_AGENT_TIMING: SubAgentTimingProfile = {
  requestTimeoutMs: 90_000,
  stallTimeoutMs: 120_000,
  wallClockTimeoutMs: 180_000,
};

const OPUS_SUB_AGENT_TIMING: SubAgentTimingProfile = {
  requestTimeoutMs: 120_000,
  stallTimeoutMs: 150_000,
  wallClockTimeoutMs: 180_000,
};

export function resolveSubAgentTimingProfile(model: string): SubAgentTimingProfile {
  const lower = model.toLowerCase();
  if (lower.includes('opus')) return OPUS_SUB_AGENT_TIMING;
  if (lower.includes('haiku')) return HAIKU_SUB_AGENT_TIMING;
  return HAIKU_SUB_AGENT_TIMING;
}

export function resolveSubAgentModel(): string {
  if (typeof window !== 'undefined') {
    const globalConfig = (window as Window & { __AGENTDOC_CONFIG__?: { ANTHROPIC_SUB_AGENT_MODEL?: string } }).__AGENTDOC_CONFIG__;
    const configuredModel = globalConfig?.ANTHROPIC_SUB_AGENT_MODEL;
    if (typeof configuredModel === 'string' && configuredModel.trim().length > 0) {
      return configuredModel.trim();
    }
  }
  return DEFAULT_SUB_AGENT_MODEL;
}

function formatInjectedSection(label: string, content: string): string {
  const tag = label.toUpperCase().replace(/[^A-Z0-9]+/g, '_');
  return `## ${label}\n\n<<${tag}_START>>\n${content}\n<<${tag}_END>>`;
}

async function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);

    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new Error('Review cancelled'));
    };

    if (signal) {
      signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeoutPromise = new Promise<T>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`${label} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });

  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function isRetryableError(message: string): boolean {
  return classifyProviderIssue(message)?.retryable ?? false;
}

type ProviderIssueKind =
  | 'timeout'
  | 'overloaded'
  | 'rate-limit'
  | 'offline'
  | 'network'
  | 'provider-unavailable';

interface ProviderIssue {
  kind: ProviderIssueKind;
  retryable: boolean;
  label: string;
}

interface RetryInfo {
  attempt: number;
  maxRetries: number;
  delayMs: number;
  message: string;
  providerIssue: ProviderIssue | null;
}

interface RetryHooks {
  onRetry?: (info: RetryInfo) => void;
  onGiveUp?: (info: Omit<RetryInfo, 'delayMs'>) => void;
}

function truncateSummary(text: string, maxChars: number = MAX_PRESENCE_SUMMARY_CHARS): string {
  const normalized = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}

function classifyProviderIssue(message: string): ProviderIssue | null {
  const lower = message.toLowerCase();

  if (lower.includes('rate limit') || lower.includes('429')) {
    return { kind: 'rate-limit', retryable: true, label: 'rate limited' };
  }

  if (lower.includes('overloaded') || lower.includes('529') || lower.includes('temporarily unavailable')) {
    return { kind: 'overloaded', retryable: true, label: 'overloaded' };
  }

  if (lower.includes('timed out') || lower.includes('timeout')) {
    return { kind: 'timeout', retryable: true, label: 'timed out' };
  }

  if (lower.includes('offline') || lower.includes('not connected to the internet') || lower.includes('-1009')) {
    return { kind: 'offline', retryable: true, label: 'offline' };
  }

  if (lower.includes('nsurlerrordomain') || lower.includes('network') || lower.includes('connection')) {
    return { kind: 'network', retryable: true, label: 'network issue' };
  }

  return null;
}

function formatProviderSummary(issue: ProviderIssue, options: { phase: 'retry' | 'final'; attempt?: number; maxRetries?: number; delayMs?: number }): string {
  if (options.phase === 'retry') {
    const retryPart =
      typeof options.attempt === 'number' && typeof options.maxRetries === 'number'
        ? `retry ${options.attempt}/${options.maxRetries}`
        : 'retrying';
    const delayPart = typeof options.delayMs === 'number' ? ` in ${Math.max(0, Math.round(options.delayMs / 1000))}s` : '';
    return truncateSummary(`Provider unavailable (${issue.label}) — ${retryPart}${delayPart}`);
  }
  return truncateSummary(`Provider unavailable (${issue.label}) — try again shortly`);
}

async function runWithRetry<T>(
  operation: () => Promise<T>,
  signal?: AbortSignal,
  hooks: RetryHooks = {}
): Promise<T> {
  let attempt = 0;

  while (true) {
    throwIfAborted(signal);
    try {
      return await operation();
    } catch (error) {
      const message = toErrorMessage(error);
      const providerIssue = classifyProviderIssue(message);
      const retryable = providerIssue?.retryable ?? isRetryableError(message);
      if (!retryable || attempt >= SUB_AGENT_MAX_RETRIES) {
        hooks.onGiveUp?.({
          attempt,
          maxRetries: SUB_AGENT_MAX_RETRIES,
          message,
          providerIssue: providerIssue ?? null,
        });
        throw error;
      }
      attempt += 1;
      const delayMs = SUB_AGENT_RETRY_BASE_DELAY_MS * attempt;
      hooks.onRetry?.({
        attempt,
        maxRetries: SUB_AGENT_MAX_RETRIES,
        delayMs,
        message,
        providerIssue: providerIssue ?? null,
      });
      await sleep(delayMs, signal);
    }
  }
}

function convertToolsToAnthropicFormat(tools: AgentTool[]): Anthropic.Tool[] {
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.inputSchema as Anthropic.Tool.InputSchema,
  }));
}

function extractTextBlocks(content: Anthropic.Message['content']): string {
  const textBlocks: string[] = [];
  for (const block of content) {
    if (block.type !== 'text') continue;
    textBlocks.push((block as TextBlock).text);
  }
  return textBlocks.join('\n').trim();
}

function extractToolError(result: unknown): string | null {
  if (!result || typeof result !== 'object') return null;
  const success = (result as { success?: unknown }).success;
  const error = (result as { error?: unknown }).error;
  if (success === false) {
    return typeof error === 'string' && error.trim().length > 0 ? error : 'Tool reported failure';
  }
  if (typeof error === 'string' && error.trim().length > 0 && success !== true) {
    return error;
  }
  return null;
}

function isNoMatchSearchResult(result: unknown): boolean {
  if (!result || typeof result !== 'object') return false;
  const success = (result as { success?: unknown }).success;
  const error = (result as { error?: unknown }).error;
  const count = (result as { count?: unknown }).count;
  const matches = (result as { matches?: unknown }).matches;

  if (success === false) {
    return typeof error === 'string' && error.toLowerCase().includes('no matches');
  }

  const numericCount = typeof count === 'number' ? count : NaN;
  if (Number.isFinite(numericCount) && numericCount === 0) {
    return true;
  }

  if (Array.isArray(matches) && matches.length === 0 && success === true) {
    return true;
  }

  return false;
}

export class SubAgentRunner {
  private client: Anthropic | null = null;

  private getClient(apiKey: string): Anthropic {
    if (!this.client) {
      this.client = new Anthropic({
        apiKey,
        dangerouslyAllowBrowser: true,
      });
    }
    return this.client;
  }

  async run(options: SubAgentRunOptions): Promise<SubAgentResult> {
    const {
      focusArea,
      agentId,
      actor,
      runId,
      markStrategy,
      singleWriter,
      styleGuideContent,
      documentContent,
      signal,
      onStatus,
    } = options;
    const config = getAgentConfig();
    const subAgentModel = resolveSubAgentModel();
    const timingProfile = resolveSubAgentTimingProfile(subAgentModel);

    if (!config.apiKey) {
      throw new Error(
        'Anthropic API key not configured. Call setApiKey() before running sub-agents.'
      );
    }

    const proposalCollector = createProposalCollector({
      source: {
        agentId,
        focusAreaId: focusArea.id,
        focusAreaName: focusArea.name,
      },
    });
    const isStyleReviewAgent = agentId.includes('style-review')
      || actor.includes('style-review')
      || agentId.includes('demo-day')
      || actor.includes('demo-day');
    const baseFocusAreaId = focusArea.id.startsWith(`${runId}-`)
      ? focusArea.id.slice(runId.length + 1) || focusArea.id
      : focusArea.id;
    const styleReviewSearchCallsMax = isStyleReviewAgent
      ? (STYLE_REVIEW_SEARCH_CALLS_MAX_BY_FOCUS[baseFocusAreaId] ?? STYLE_REVIEW_SEARCH_CALLS_MAX_DEFAULT)
      : null;
    let candidateCount = 0;
    let lastPresenceProposalTotal = 0;
    const handleToolEvent = (event: { type: 'candidates' | 'proposals'; count: number; focusAreaId?: string }): void => {
      const nextCount = Number.isFinite(event.count) ? Math.max(0, Math.floor(event.count)) : 0;
      const timestamp = Date.now();

      if (event.type === 'candidates' && nextCount > 0 && nextCount !== candidateCount) {
        candidateCount = nextCount;
        void updateExternalAgentPresence({
          agentId,
          status: 'acting',
          summary: `Found ${candidateCount} candidate${candidateCount === 1 ? '' : 's'}`,
          timestamp,
        });
      }

      if (event.type === 'proposals' && nextCount > lastPresenceProposalTotal) {
        lastPresenceProposalTotal = nextCount;
        void updateExternalAgentPresence({
          agentId,
          status: 'acting',
          summary: `Sending ${lastPresenceProposalTotal} proposal${lastPresenceProposalTotal === 1 ? '' : 's'}`,
          timestamp,
        });
      }

      const debugState = subAgentDebugStates.get(agentId);
      if (debugState) {
        subAgentDebugStates.set(agentId, {
          ...debugState,
          candidateCount,
          proposalCounts: proposalCollector.counts(),
          lastUpdated: timestamp,
        });
      }
    };

    if (markStrategy === 'visible-provisional') {
      console.info('[SubAgentRunner] visible-provisional requested; running propose-only and delegating previews to orchestrator.');
    }

    const toolMode: 'propose' = 'propose';
    let tools = getHttpBridgeTools({
      agentId,
      actor,
      signal,
      mode: toolMode,
      proposalCollector,
      runId,
      focusAreaId: focusArea.id,
      focusAreaName: focusArea.name,
      provisionalMarks: false,
      singleWriter,
      documentContent,
      onToolEvent: handleToolEvent,
    });
    if (isStyleReviewAgent && baseFocusAreaId === 'headlines') {
      tools = tools.filter((tool) => tool.name !== 'search');
    }
    const anthropicTools = convertToolsToAnthropicFormat(tools);
    const toolHandlers = new Map<string, AgentTool['handler']>(
      tools.map((tool) => [tool.name, tool.handler])
    );

    const messages: MessageParam[] = [{ role: 'user', content: 'Begin your review.' }];
    let toolCalls = 0;
    let rawText = '';
    const injectedSections: string[] = [];
    if (typeof styleGuideContent === 'string' && styleGuideContent.trim().length > 0) {
      injectedSections.push(formatInjectedSection('Style Guide (Source of Truth)', styleGuideContent));
    }
    if (typeof documentContent === 'string' && documentContent.trim().length > 0) {
      injectedSections.push(formatInjectedSection('Document (Full Text)', documentContent));
    }
    const systemPrompt = [focusArea.systemPrompt, ORCHESTRATION_PROTOCOL, ...injectedSections].join('\n\n');
    const startedAt = Date.now();
    const toolNames: string[] = [];
    const toolErrors: string[] = [];

    subAgentDebugStates.set(agentId, {
      agentId,
      focusAreaId: focusArea.id,
      focusAreaName: focusArea.name,
      status: 'running',
      toolCalls: 0,
      proposalCounts: { total: 0, suggestions: 0, comments: 0 },
      candidateCount: 0,
      toolNames: [],
      toolErrors: [],
      searchCallsUsed: 0,
      searchCallsMax: styleReviewSearchCallsMax,
      searchCallsRemaining: styleReviewSearchCallsMax,
      regexNoMatchBudgetRemaining: REGEX_NO_MATCH_BUDGET_MAX,
      regexNoMatchBudgetExhausted: false,
      searchDenialsAfterBudgetExhausted: 0,
      rawTextPreview: '',
      startedAt,
      finishedAt: null,
      error: null,
      lastUpdated: startedAt,
    });

    onStatus?.({
      focusAreaId: focusArea.id,
      focusAreaName: focusArea.name,
      agentId,
      status: 'running',
      message: `Reviewing ${focusArea.name}`,
    });

    const presenceTimestamp = Date.now();
    void updateExternalAgentPresence({
      agentId,
      status: 'thinking',
      summary: `Reviewing ${focusArea.name}`,
      timestamp: presenceTimestamp,
    });

    const heartbeatHandle = onStatus
      ? setInterval(() => {
        onStatus({
          focusAreaId: focusArea.id,
          focusAreaName: focusArea.name,
          agentId,
          status: 'running',
          suggestionCount: proposalCollector.counts().suggestions,
          message: `Working on ${focusArea.name}`,
        });
      }, SUB_AGENT_HEARTBEAT_MS)
      : null;

    let finalStatus: SubAgentResult['status'] = 'completed';
    let finalError: string | undefined;
    let completedNormally = false;
    let consecutiveNoMatchSearches = 0;
    let lastProposalTotal = 0;
    let lastNoMatchSearchKey = '';
    let identicalNoMatchSearchRepeats = 0;
    let consecutiveRegexNoMatchSearches = 0;
    let toolCallsSinceProposalGrowth = 0;
    let regexNoMatchBudgetRemaining = REGEX_NO_MATCH_BUDGET_MAX;
    let regexNoMatchBudgetExhausted = false;
    let searchDenialsAfterBudgetExhausted = 0;
    let searchCallsUsedSubAgent = 0;
    type StructuralCandidateInfo = {
      candidateId: string;
      text: string;
      signals?: { hedDekLabel?: string | null } | null;
    };
    const listedCandidates = new Map<string, StructuralCandidateInfo>();
    const requiredCandidateIds = new Set<string>();
    const acceptedCandidateIds = new Set<string>();
    let candidateEnforcementAttempts = 0;
    let nextToolChoiceName: string | null = null;

    const isHeadlinesFocus = isStyleReviewAgent && baseFocusAreaId === 'headlines';
    const getRequiredRemainingCandidates = (): StructuralCandidateInfo[] => {
      if (!isHeadlinesFocus) return [];
      const remaining: StructuralCandidateInfo[] = [];
      for (const candidateId of requiredCandidateIds) {
        if (acceptedCandidateIds.has(candidateId)) continue;
        const info = listedCandidates.get(candidateId);
        if (info) remaining.push(info);
      }
      return remaining;
    };
    const maybeEnforceRequiredCandidates = (): boolean => {
      const remaining = getRequiredRemainingCandidates();
      if (remaining.length === 0) return false;
      if (candidateEnforcementAttempts >= 2) return false;
      candidateEnforcementAttempts += 1;

      const remainingLines = remaining.map((candidate) => {
        const label = candidate.signals?.hedDekLabel ?? 'candidate';
        const preview = candidate.text.replace(/\s+/g, ' ').slice(0, 120);
        return `- ${candidate.candidateId} (${label}): ${preview}`;
      }).join('\n');

      const message = `You listed Hed/Dek candidates that must be converted to headings, but you have not proposed changes for all of them yet. Process the remaining candidates now using propose_change with candidateId. Use "#" for Hed and "##" for Dek. Remaining:\n${remainingLines}`;
      messages.push({ role: 'user', content: message });
      nextToolChoiceName = PROPOSE_CHANGE_TOOL_CHOICE.name;
      rawText = rawText
        ? `${rawText}\nEnforcing Hed/Dek candidate processing (${candidateEnforcementAttempts}).`
        : `Enforcing Hed/Dek candidate processing (${candidateEnforcementAttempts}).`;
      return true;
    };

    try {
      for (let iteration = 0; iteration < MAX_ITERATIONS; iteration += 1) {
        throwIfAborted(signal);

        const toolChoiceName = nextToolChoiceName;
        nextToolChoiceName = null;
        const toolChoicePart = toolChoiceName
          ? { tool_choice: { type: 'tool', name: toolChoiceName } }
          : {};

        const requestOperation = async (): Promise<Anthropic.Message> => {
          const client = this.getClient(config.apiKey);
          const browserPromise = client.messages.create({
            model: subAgentModel,
            max_tokens: SUB_AGENT_MAX_TOKENS,
            system: systemPrompt,
            tools: anthropicTools,
            messages,
            ...toolChoicePart,
            signal,
          });
          return withTimeout(browserPromise, timingProfile.requestTimeoutMs, 'Sub-agent request');
        };

        let lastProviderSummary = '';
        const setProviderSummary = (status: 'waiting' | 'error', summary: string): void => {
          const nextSummary = truncateSummary(summary);
          if (!nextSummary || nextSummary === lastProviderSummary) return;
          lastProviderSummary = nextSummary;
          const timestamp = Date.now();
          void updateExternalAgentPresence({
            agentId,
            status,
            summary: nextSummary,
            timestamp,
          });
          onStatus?.({
            focusAreaId: focusArea.id,
            focusAreaName: focusArea.name,
            agentId,
            status: status === 'error' ? 'error' : 'running',
            message: nextSummary,
          });
        };

        const result = await runWithRetry(requestOperation, signal, {
          onRetry: (info) => {
            if (!info.providerIssue) return;
            const summary = formatProviderSummary(info.providerIssue, {
              phase: 'retry',
              attempt: info.attempt,
              maxRetries: info.maxRetries,
              delayMs: info.delayMs,
            });
            setProviderSummary('waiting', summary);
          },
          onGiveUp: (info) => {
            if (!info.providerIssue) return;
            const summary = formatProviderSummary(info.providerIssue, { phase: 'final' });
            setProviderSummary('error', summary);
          },
        });

        throwIfAborted(signal);

        const toolUseBlocks: ToolUseBlock[] = [];
        const textResponse = extractTextBlocks(result.content);
        if (textResponse) {
          rawText = rawText ? `${rawText}\n${textResponse}` : textResponse;
        }

        for (const block of result.content) {
          if (block.type !== 'tool_use') continue;
          toolUseBlocks.push(block as ToolUseBlock);
        }

        if (toolUseBlocks.length === 0) {
          if (maybeEnforceRequiredCandidates()) {
            continue;
          }
          completedNormally = true;
          break;
        }

        messages.push({ role: 'assistant', content: result.content as ContentBlockParam[] });

        const toolResults: ToolResultBlockParam[] = [];
        let repeatedNoMatchSearchLoopDetected = false;
        let regexSearchBudgetExhaustedThisTurn = false;
        let skipFurtherSearches = regexNoMatchBudgetExhausted;
        let scopeEnforcementErrorsSinceProposalGrowth = 0;
        for (const toolBlock of toolUseBlocks) {
          throwIfAborted(signal);

          if (skipFurtherSearches && toolBlock.name === 'search') {
            const exhaustedError =
              'No matches budget exhausted: search budget is exhausted for this turn. Do not run more searches.';
            const syntheticResult = {
              success: false,
              count: 0,
              matches: [],
              error: exhaustedError,
              budget: {
                max: REGEX_NO_MATCH_BUDGET_MAX,
                remaining: 0,
                exhausted: true,
                searchCallsUsed: searchCallsUsedSubAgent,
                searchCallsMax: styleReviewSearchCallsMax,
                searchCallsRemaining: styleReviewSearchCallsMax === null
                  ? null
                  : Math.max(0, styleReviewSearchCallsMax - searchCallsUsedSubAgent),
                denialCount: searchDenialsAfterBudgetExhausted,
              },
              budgetMessage: exhaustedError,
            };
            toolNames.push(toolBlock.name);
            if (toolErrors.length < 10) {
              toolErrors.push(`${toolBlock.name}: ${exhaustedError}`);
            }
            toolResults.push({
              type: 'tool_result',
              tool_use_id: toolBlock.id,
              content: JSON.stringify(syntheticResult),
            });
            regexNoMatchBudgetExhausted = true;
            regexSearchBudgetExhaustedThisTurn = true;
            searchDenialsAfterBudgetExhausted += 1;
            continue;
          }

          if (isStyleReviewAgent && toolBlock.name === 'search') {
            if (styleReviewSearchCallsMax !== null && searchCallsUsedSubAgent >= styleReviewSearchCallsMax) {
              const exhaustedError = `No matches budget exhausted: search call budget exhausted (${searchCallsUsedSubAgent}/${styleReviewSearchCallsMax}).`;
              const syntheticResult = {
                success: false,
                count: 0,
                matches: [],
                error: exhaustedError,
                budget: {
                  max: REGEX_NO_MATCH_BUDGET_MAX,
                  remaining: 0,
                  exhausted: true,
                  searchCallsUsed: searchCallsUsedSubAgent,
                  searchCallsMax: styleReviewSearchCallsMax,
                  searchCallsRemaining: 0,
                  denialCount: searchDenialsAfterBudgetExhausted,
                },
                budgetMessage: exhaustedError,
              };
              toolNames.push(toolBlock.name);
              if (toolErrors.length < 10) {
                toolErrors.push(`${toolBlock.name}: ${exhaustedError}`);
              }
              toolResults.push({
                type: 'tool_result',
                tool_use_id: toolBlock.id,
                content: JSON.stringify(syntheticResult),
              });
              regexNoMatchBudgetExhausted = true;
              regexSearchBudgetExhaustedThisTurn = true;
              skipFurtherSearches = true;
              searchDenialsAfterBudgetExhausted += 1;
              continue;
            }
            searchCallsUsedSubAgent += 1;
          }

          toolCalls += 1;
          toolCallsSinceProposalGrowth += 1;

          const handler = toolHandlers.get(toolBlock.name);
          const missingToolError = toolBlock.name === 'create_suggestion' || toolBlock.name === 'add_comment'
            ? 'Tool not available in orchestrated mode. Use propose_change instead.'
            : `Unknown tool: ${toolBlock.name}`;
          let toolResult = handler
            ? await handler(toolBlock.input as Record<string, unknown>)
            : { success: false, error: missingToolError };

          toolNames.push(toolBlock.name);
          const toolError = extractToolError(toolResult);
          if (toolError && toolErrors.length < 10) {
            toolErrors.push(`${toolBlock.name}: ${toolError}`);
          }
          if (toolError && toolError.includes('Focus scope enforcement')) {
            scopeEnforcementErrorsSinceProposalGrowth += 1;
          }

          if (toolBlock.name === 'list_candidates' && toolResult && typeof toolResult === 'object') {
            const candidatesRaw = (toolResult as { candidates?: unknown }).candidates;
            const candidates = Array.isArray(candidatesRaw) ? candidatesRaw : [];
            listedCandidates.clear();
            requiredCandidateIds.clear();
            for (const candidate of candidates) {
              if (!candidate || typeof candidate !== 'object') continue;
              const candidateIdValue = (candidate as { candidateId?: unknown }).candidateId;
              if (typeof candidateIdValue !== 'string') continue;
              const candidateId = candidateIdValue.trim();
              if (!candidateId) continue;
              const textValue = (candidate as { text?: unknown }).text;
              const text = typeof textValue === 'string' ? textValue : '';
              const signalsValue = (candidate as { signals?: unknown }).signals;
              const signals = signalsValue && typeof signalsValue === 'object'
                ? signalsValue as { hedDekLabel?: string | null }
                : null;
              listedCandidates.set(candidateId, { candidateId, text, signals });
              const label = signals?.hedDekLabel;
              if (label === 'hed' || label === 'dek' || label === 'hed-dek') {
                requiredCandidateIds.add(candidateId);
              }
            }
          }

          if (toolBlock.name === 'propose_change') {
            const inputCandidateId = typeof (toolBlock.input as { candidateId?: unknown })?.candidateId === 'string'
              ? String((toolBlock.input as { candidateId?: unknown }).candidateId).trim()
              : '';
            const accepted = toolResult && typeof toolResult === 'object'
              ? (toolResult as { accepted?: unknown }).accepted === true
              : false;
            if (inputCandidateId && accepted) {
              acceptedCandidateIds.add(inputCandidateId);
            }
          }

          if (toolBlock.name === 'search') {
            const searchInput = toolBlock.input as { type?: unknown } | undefined;
            const searchTypeRaw = typeof searchInput?.type === 'string' ? searchInput.type : '';
            const isRegexSearch = searchTypeRaw === 'regex'
              || (isStyleReviewAgent && searchTypeRaw !== 'text');
            const isRegexNoMatchSearch = isRegexSearch && isNoMatchSearchResult(toolResult);
            const isRegexMatchSearch = isRegexSearch && !isNoMatchSearchResult(toolResult);
            const toolBudget = isRegexSearch && toolResult && typeof toolResult === 'object'
              ? (toolResult as { budget?: unknown }).budget as { remaining?: unknown; exhausted?: unknown; max?: unknown } | undefined
              : undefined;
            const toolBudgetProvided = isRegexSearch && toolBudget && typeof toolBudget.remaining === 'number';
            if (toolBudgetProvided) {
              regexNoMatchBudgetRemaining = Math.max(0, Number(toolBudget.remaining));
              regexNoMatchBudgetExhausted = toolBudget.exhausted === true;
              if (regexNoMatchBudgetExhausted) {
                searchDenialsAfterBudgetExhausted += 1;
                regexSearchBudgetExhaustedThisTurn = true;
              } else if (regexNoMatchBudgetRemaining >= REGEX_NO_MATCH_BUDGET_MAX) {
                searchDenialsAfterBudgetExhausted = 0;
              }
            }

            if (isNoMatchSearchResult(toolResult)) {
              consecutiveNoMatchSearches += 1;
            } else {
              consecutiveNoMatchSearches = 0;
            }

            if (isRegexNoMatchSearch && !toolBudgetProvided && !regexNoMatchBudgetExhausted) {
              consecutiveRegexNoMatchSearches += 1;
              regexNoMatchBudgetRemaining = Math.max(0, regexNoMatchBudgetRemaining - 1);
              const searchKey = JSON.stringify(toolBlock.input ?? {});
              if (searchKey === lastNoMatchSearchKey) {
                identicalNoMatchSearchRepeats += 1;
              } else {
                lastNoMatchSearchKey = searchKey;
                identicalNoMatchSearchRepeats = 1;
              }
              if (identicalNoMatchSearchRepeats >= MAX_IDENTICAL_NO_MATCH_SEARCH_REPEATS) {
                repeatedNoMatchSearchLoopDetected = true;
              }
              if (regexNoMatchBudgetRemaining <= 0) {
                regexNoMatchBudgetExhausted = true;
                regexSearchBudgetExhaustedThisTurn = true;
              }
            } else if (isRegexMatchSearch) {
              consecutiveRegexNoMatchSearches = 0;
              lastNoMatchSearchKey = '';
              identicalNoMatchSearchRepeats = 0;
              regexNoMatchBudgetRemaining = REGEX_NO_MATCH_BUDGET_MAX;
              regexNoMatchBudgetExhausted = false;
              searchDenialsAfterBudgetExhausted = 0;
            } else if (!isRegexSearch) {
              consecutiveRegexNoMatchSearches = 0;
              lastNoMatchSearchKey = '';
              identicalNoMatchSearchRepeats = 0;
            }

            // Surface the remaining regex no-match budget to the model so it can stop early.
            if (isRegexSearch) {
              const remaining = regexNoMatchBudgetExhausted ? 0 : regexNoMatchBudgetRemaining;
              const searchCallsRemaining = isStyleReviewAgent
                ? Math.max(0, (styleReviewSearchCallsMax ?? STYLE_REVIEW_SEARCH_CALLS_MAX_DEFAULT) - searchCallsUsedSubAgent)
                : null;
              const baseBudgetMessage = toolResult && typeof toolResult === 'object'
                ? (toolResult as { budgetMessage?: unknown }).budgetMessage
                : null;
              const budgetMessageCore = typeof baseBudgetMessage === 'string' && baseBudgetMessage.trim().length > 0
                ? baseBudgetMessage
                : regexNoMatchBudgetExhausted
                  ? `Regex no-match search budget exhausted. Do not run more regex searches.`
                  : remaining <= 1
                    ? `Regex no-match search budget low: ${remaining}/${REGEX_NO_MATCH_BUDGET_MAX} remaining.`
                    : `Regex no-match search budget: ${remaining}/${REGEX_NO_MATCH_BUDGET_MAX} remaining.`;
              const budgetMessage =
                searchCallsRemaining === null
                  ? budgetMessageCore
                  : `${budgetMessageCore} Search calls remaining: ${searchCallsRemaining}/${styleReviewSearchCallsMax ?? STYLE_REVIEW_SEARCH_CALLS_MAX_DEFAULT}.`;
              const base =
                toolResult && typeof toolResult === 'object'
                  ? toolResult as Record<string, unknown>
                  : { result: toolResult };
              const baseBudget = base.budget && typeof base.budget === 'object'
                ? base.budget as Record<string, unknown>
                : {};
              toolResult = {
                ...base,
                budget: {
                  max: typeof baseBudget.max === 'number' ? baseBudget.max : REGEX_NO_MATCH_BUDGET_MAX,
                  remaining,
                  exhausted: regexNoMatchBudgetExhausted,
                  ...baseBudget,
                  searchCallsUsed: isStyleReviewAgent ? searchCallsUsedSubAgent : null,
                  searchCallsMax: styleReviewSearchCallsMax,
                  searchCallsRemaining: isStyleReviewAgent ? searchCallsRemaining : null,
                  denialCount: searchDenialsAfterBudgetExhausted,
                },
                budgetMessage,
              };
            }

            if (regexNoMatchBudgetExhausted) {
              skipFurtherSearches = true;
            }
          }

          toolResults.push({
            type: 'tool_result',
            tool_use_id: toolBlock.id,
            content: JSON.stringify(toolResult),
          });
        }

        messages.push({ role: 'user', content: toolResults });

        if (regexNoMatchBudgetExhausted && regexSearchBudgetExhaustedThisTurn) {
          rawText = rawText
            ? `${rawText}\nStopping immediately because the regex no-match search budget is exhausted.`
            : 'Stopping immediately because the regex no-match search budget is exhausted.';
          completedNormally = true;
          break;
        }

        if (repeatedNoMatchSearchLoopDetected) {
          rawText = rawText
            ? `${rawText}\nStopping early after repeated identical searches with no matches.`
            : 'Stopping early after repeated identical searches with no matches.';
          completedNormally = true;
          break;
        }

        const proposalTotal = proposalCollector.counts().total;
        if (proposalTotal > lastProposalTotal) {
          lastProposalTotal = proposalTotal;
          consecutiveNoMatchSearches = 0;
          lastNoMatchSearchKey = '';
          identicalNoMatchSearchRepeats = 0;
          consecutiveRegexNoMatchSearches = 0;
          toolCallsSinceProposalGrowth = 0;
          scopeEnforcementErrorsSinceProposalGrowth = 0;
        } else if (
          scopeEnforcementErrorsSinceProposalGrowth >= MAX_SCOPE_ENFORCEMENT_ERRORS_WITHOUT_PROGRESS
          && toolCallsSinceProposalGrowth >= MIN_TOOL_CALLS_SINCE_PROPOSAL_GROWTH_FOR_SCOPE_BREAK
        ) {
          rawText = rawText
            ? `${rawText}\nStopping early after repeated focus scope enforcement errors without proposal growth.`
            : 'Stopping early after repeated focus scope enforcement errors without proposal growth.';
          completedNormally = true;
          break;
        } else if (
          regexNoMatchBudgetExhausted
          && searchDenialsAfterBudgetExhausted >= MAX_SEARCH_DENIALS_AFTER_BUDGET_EXHAUSTED
          && toolCallsSinceProposalGrowth >= MIN_TOOL_CALLS_SINCE_PROPOSAL_GROWTH_FOR_BREAK
        ) {
          rawText = rawText
            ? `${rawText}\nStopping early after regex search budget was exhausted and additional searches were denied without new proposals.`
            : 'Stopping early after regex search budget was exhausted and additional searches were denied without new proposals.';
          completedNormally = true;
          break;
        } else if (
          consecutiveRegexNoMatchSearches >= MAX_CONSECUTIVE_REGEX_NO_MATCH_SEARCHES
          && toolCallsSinceProposalGrowth >= MIN_TOOL_CALLS_SINCE_PROPOSAL_GROWTH_FOR_BREAK
        ) {
          rawText = rawText
            ? `${rawText}\nStopping early after repeated regex searches returned no matches and proposals have not increased.`
            : 'Stopping early after repeated regex searches returned no matches and proposals have not increased.';
          completedNormally = true;
          break;
        } else if (proposalTotal === 0 && toolCalls >= MAX_TOOL_CALLS_WITHOUT_PROPOSALS) {
          rawText = rawText
            ? `${rawText}\nStopping after many tool calls with no viable changes found.`
            : 'Stopping after many tool calls with no viable changes found.';
          completedNormally = true;
          break;
        } else if (consecutiveNoMatchSearches >= MAX_CONSECUTIVE_NO_MATCH_SEARCHES) {
          rawText = rawText
            ? `${rawText}\nStopping early after repeated searches with no matches.`
            : 'Stopping early after repeated searches with no matches.';
          completedNormally = true;
          break;
        }

        if (toolCalls >= MAX_TOOL_CALLS_TOTAL) {
          rawText = rawText
            ? `${rawText}\nStopping after reaching the tool call limit for this focus area.`
            : 'Stopping after reaching the tool call limit for this focus area.';
          completedNormally = true;
          break;
        }

        if (result.stop_reason === 'end_turn' || result.stop_reason === 'stop_sequence') {
          if (maybeEnforceRequiredCandidates()) {
            continue;
          }
          completedNormally = true;
          break;
        }
      }

      if (!completedNormally) {
        throw new Error('Sub-agent iteration limit reached');
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      const abortReason = signal?.reason;
      const abortReasonMessage = abortReason instanceof Error
        ? abortReason.message
        : typeof abortReason === 'string'
          ? abortReason
          : '';
      const providerIssue = classifyProviderIssue(abortReasonMessage || errorMessage);

      if (signal?.aborted) {
        // Treat provider timeouts/unavailability as errors so the UI and scripts
        // can fail fast with a useful message instead of looking "stuck".
        if (providerIssue) {
          finalStatus = 'error';
          finalError = abortReasonMessage || errorMessage;
        } else {
          finalStatus = 'cancelled';
          if (abortReasonMessage.trim()) {
            finalError = abortReasonMessage;
          } else if (errorMessage && !errorMessage.toLowerCase().includes('cancel')) {
            finalError = errorMessage;
          }
        }
      } else if (errorMessage.toLowerCase().includes('cancel')) {
        finalStatus = 'cancelled';
        finalError = errorMessage;
      } else {
        finalStatus = 'error';
        finalError = errorMessage;
        console.error(`[SubAgentRunner] Focus area ${focusArea.id} failed:`, error);
      }
    } finally {
      if (heartbeatHandle) {
        clearInterval(heartbeatHandle);
      }
    }

    const proposalCounts = proposalCollector.counts();
    const suggestionCount = proposalCounts.suggestions;
    const proposals = proposalCollector.list();
    const finishedAt = Date.now();
    const rawTextPreview = rawText.slice(0, 200);
    const searchCallsRemaining = styleReviewSearchCallsMax === null
      ? null
      : Math.max(0, styleReviewSearchCallsMax - searchCallsUsedSubAgent);

    subAgentDebugStates.set(agentId, {
      agentId,
      focusAreaId: focusArea.id,
      focusAreaName: focusArea.name,
      status: finalStatus,
      toolCalls,
      proposalCounts,
      candidateCount,
      toolNames: toolNames.slice(-25),
      toolErrors,
      searchCallsUsed: searchCallsUsedSubAgent,
      searchCallsMax: styleReviewSearchCallsMax,
      searchCallsRemaining,
      regexNoMatchBudgetRemaining,
      regexNoMatchBudgetExhausted,
      searchDenialsAfterBudgetExhausted,
      rawTextPreview,
      startedAt,
      finishedAt,
      error: finalError ?? null,
      lastUpdated: finishedAt,
    });

    const providerIssue = finalError ? classifyProviderIssue(finalError) : null;
    const providerSummary = providerIssue
      ? formatProviderSummary(providerIssue, { phase: 'final' })
      : null;

    onStatus?.({
      focusAreaId: focusArea.id,
      focusAreaName: focusArea.name,
      agentId,
      status: finalStatus,
      suggestionCount,
      message: finalStatus === 'completed'
        ? `${focusArea.name} complete`
        : finalStatus === 'cancelled'
          ? `${focusArea.name} cancelled`
          : providerSummary ?? `${focusArea.name} failed`,
    });

    // Ensure the sidebar presence shows a meaningful final state instead of
    // the last tool summary (often "Searching document").
    const finalSummary = finalStatus === 'completed'
      ? (proposalCounts.total > 0
          ? `Sent ${proposalCounts.total} proposal${proposalCounts.total === 1 ? '' : 's'}`
          : 'Finished with no proposals')
      : finalStatus === 'cancelled'
        ? (proposalCounts.total > 0
            ? `Cancelled after ${proposalCounts.total} proposal${proposalCounts.total === 1 ? '' : 's'}`
            : 'Cancelled')
        : providerSummary
          ? providerSummary
          : finalError
            ? `Failed: ${truncateSummary(finalError)}`
            : 'Failed';
    const finalPresenceTimestamp = Date.now();
    void updateExternalAgentPresence({
      agentId,
      status: finalStatus,
      summary: truncateSummary(finalSummary),
      timestamp: finalPresenceTimestamp,
    });

    const clearTimestamp = Date.now();
    clearExternalAgentSession({ agentId, timestamp: clearTimestamp });

    return {
      agentId,
      focusAreaId: focusArea.id,
      focusAreaName: focusArea.name,
      status: finalStatus,
      suggestionCount,
      proposalCounts,
      proposals,
      toolCalls,
      error: finalError,
      rawText: rawText || undefined,
    };
  }
}

export const subAgentRunner = new SubAgentRunner();
