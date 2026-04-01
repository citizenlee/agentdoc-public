import Anthropic from '@anthropic-ai/sdk';
import type {
  MessageParam,
  ContentBlockParam,
  ToolResultBlockParam,
  ToolUseBlock,
  TextBlock,
} from '@anthropic-ai/sdk/resources/messages';
import type { Skill } from './skills/registry';
import { getAgentConfig } from './config';
import { dedupeProposals, type DedupedProposalResult, type SubAgentProposal } from './proposals';
import { getHttpBridgeTools } from './tools/http-bridge-tools';
import type { AgentTool } from './types';

export interface OrchestratorSynthesisOptions {
  skill: Skill;
  document: string;
  proposals: SubAgentProposal[];
  agentId: string;
  actor: string;
  runId?: string;
  signal?: AbortSignal;
}

export interface OrchestratorSynthesisResult {
  status: 'completed' | 'error' | 'cancelled';
  proposalsReceived: number;
  proposalsConsidered: number;
  duplicatesRemoved: number;
  truncated: number;
  invalidRemoved: number;
  invalidReasons: Record<string, number>;
  appliedSuggestionCount: number;
  appliedCommentCount: number;
  toolCalls: number;
  error?: string;
  rawText?: string;
}

const SYNTHESIS_MODEL = 'claude-opus-4-5-20251101';
const SYNTHESIS_MAX_TOKENS = 2048;
const SYNTHESIS_MAX_ITERATIONS = 80;
const SYNTHESIS_DOCUMENT_CHAR_LIMIT = 8_000;
const SYNTHESIS_MAX_RETRIES = 2;
const SYNTHESIS_RETRY_BASE_DELAY_MS = 1_500;
const SYNTHESIS_REQUEST_TIMEOUT_MS = 120_000;

type SynthesisDebugStatus = 'idle' | 'running' | OrchestratorSynthesisResult['status'];

interface SynthesisDebugState {
  status: SynthesisDebugStatus;
  proposalsReceived: number;
  proposalsConsidered: number;
  duplicatesRemoved: number;
  truncated: number;
  invalidRemoved: number;
  invalidReasons: Record<string, number>;
  toolCalls: number;
  appliedSuggestionCount: number;
  appliedCommentCount: number;
  toolNames: string[];
  toolErrors: string[];
  startedAt: number | null;
  finishedAt: number | null;
  error: string | null;
  rawTextPreview: string;
  lastUpdated: number | null;
}

let synthesisDebugState: SynthesisDebugState = {
  status: 'idle',
  proposalsReceived: 0,
  proposalsConsidered: 0,
  duplicatesRemoved: 0,
  truncated: 0,
  invalidRemoved: 0,
  invalidReasons: {},
  toolCalls: 0,
  appliedSuggestionCount: 0,
  appliedCommentCount: 0,
  toolNames: [],
  toolErrors: [],
  startedAt: null,
  finishedAt: null,
  error: null,
  rawTextPreview: '',
  lastUpdated: null,
};

function updateSynthesisDebugState(patch: Partial<SynthesisDebugState>): void {
  synthesisDebugState = {
    ...synthesisDebugState,
    ...patch,
    lastUpdated: Date.now(),
  };
}

if (typeof window !== 'undefined') {
  (window as Window & {
    __agentdocSynthesisDebug?: { get: () => SynthesisDebugState };
  }).__agentdocSynthesisDebug = {
    get: () => synthesisDebugState,
  };
}

const SYNTHESIS_PROMPT = `You are the review orchestrator. Sub-agents have proposed changes. Your job is to synthesize them into a coherent, non-conflicting set of edits and apply them.

## Critical Rules

- You must apply accepted edits yourself using the tools.
- Do not ask sub-agents to apply edits.
- Before applying edits, check for existing marks with get_marks().
- Avoid duplicate or conflicting suggestions.
- If a proposal is weak or incorrect, skip it.
- Only apply small, surgical edits. Skip large rewrites, but structural edits (headings, captions, and short lists) are allowed when required by the style guide.
- Never apply no-op proposals where the replacement is effectively identical to the quote.
- Apply clear, high-confidence mechanical fixes even if there are many of them.
- Be careful with italics: punctuation that follows italicized text should usually sit outside the italics markers.

## Available Tools

- read_document()
- search({ pattern, type })
- get_marks()
- create_suggestion({ type, quote, content })
- add_comment({ quote, text })

## Skill Prompt

{skillPrompt}

## Document Context (Truncated)

{document}

## Proposal Summary

{proposalSummary}

## Proposed Changes (JSON)

{proposals}

## Process

1. Review the proposals and identify conflicts or duplicates.
2. Use read_document/search as needed to confirm the correct fix.
3. Call create_suggestion/add_comment to apply the final changes.
4. When finished, respond with a short summary of what you applied.`;

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new Error('Review cancelled');
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

function isToolFailure(result: unknown): boolean {
  if (!result || typeof result !== 'object') return false;
  const success = (result as { success?: unknown }).success;
  if (success === false) return true;
  const error = (result as { error?: unknown }).error;
  return typeof error === 'string' && error.trim().length > 0 && success !== true;
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

function summarizeProposals(
  proposalsReceived: number,
  proposalsConsidered: number,
  duplicatesRemoved: number,
  invalidRemoved: number,
  invalidReasons: Record<string, number>,
  truncated: number
): string {
  const lines = [
    `Proposals received: ${proposalsReceived}`,
    `Duplicates removed: ${duplicatesRemoved}`,
    `Proposals considered: ${proposalsConsidered}`,
  ];
  if (invalidRemoved > 0) {
    lines.push(`Invalid proposals removed: ${invalidRemoved}`);
    const reasonEntries = Object.entries(invalidReasons);
    if (reasonEntries.length > 0) {
      const reasonSummary = reasonEntries
        .sort((a, b) => b[1] - a[1])
        .slice(0, 4)
        .map(([reason, count]) => `${reason}=${count}`)
        .join(', ');
      if (reasonSummary) {
        lines.push(`Invalid reasons: ${reasonSummary}`);
      }
    }
  }
  if (truncated > 0) {
    lines.push(`Proposals truncated due to synthesis limit: ${truncated}`);
  }
  return lines.join('\n');
}

function formatProposalsForPrompt(proposals: SubAgentProposal[]): string {
  const promptReady = proposals.map((proposal, index) => {
    const base = {
      index: index + 1,
      focusAreaId: proposal.focusAreaId,
      focusAreaName: proposal.focusAreaName,
      agentId: proposal.agentId,
      kind: proposal.change.kind,
      quote: proposal.change.quote,
      rationale: proposal.change.rationale ?? undefined,
    } as Record<string, unknown>;

    if (proposal.change.kind === 'suggestion') {
      base.suggestionType = proposal.change.suggestionType;
      base.content = proposal.change.content ?? '';
    } else {
      base.text = proposal.change.text;
    }

    return base;
  });

  try {
    return JSON.stringify(promptReady, null, 2);
  } catch {
    return '[]';
  }
}

function buildSynthesisDocumentContext(document: string): string {
  const normalized = document.trim();
  if (normalized.length <= SYNTHESIS_DOCUMENT_CHAR_LIMIT) {
    return normalized;
  }

  const excerpt = normalized.slice(0, SYNTHESIS_DOCUMENT_CHAR_LIMIT);
  return [
    `Document length: ${normalized.length} characters.`,
    `Only the first ${SYNTHESIS_DOCUMENT_CHAR_LIMIT} characters are included below.`,
    'Use read_document() to access the full document when needed.',
    '',
    excerpt,
    '',
    '[Document truncated]',
  ].join('\n');
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      if (signal) signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);

    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error('Review cancelled'));
    };

    if (!signal) return;
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener('abort', onAbort, { once: true });
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
  const lower = message.toLowerCase();
  return (
    lower.includes('overloaded') ||
    lower.includes('529') ||
    lower.includes('timeout') ||
    lower.includes('timed out') ||
    lower.includes('-1001')
  );
}

async function runWithRetry<T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= SYNTHESIS_MAX_RETRIES; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      const message = error instanceof Error ? error.message : String(error);
      if (!isRetryableError(message) || attempt === SYNTHESIS_MAX_RETRIES) {
        throw error;
      }

      const delayMs = SYNTHESIS_RETRY_BASE_DELAY_MS * (attempt + 1);
      console.warn(
        `[OrchestratorSynthesizerAgent] Retryable error (attempt ${attempt + 1}/${SYNTHESIS_MAX_RETRIES + 1}): ${message}`
      );
      await sleep(delayMs, signal);
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

function buildSynthesisPrompt(
  skill: Skill,
  document: string,
  deduped: DedupedProposalResult,
  proposalsReceived: number
): string {
  const documentContext = buildSynthesisDocumentContext(document);
  const proposalSummary = summarizeProposals(
    proposalsReceived,
    deduped.proposals.length,
    deduped.duplicatesRemoved,
    deduped.invalidRemoved,
    deduped.invalidReasons,
    deduped.truncated
  );
  const proposalsJson = formatProposalsForPrompt(deduped.proposals);

  return SYNTHESIS_PROMPT
    .replace('{skillPrompt}', () => skill.prompt)
    .replace('{document}', () => documentContext)
    .replace('{proposalSummary}', () => proposalSummary)
    .replace('{proposals}', () => proposalsJson);
}

export class OrchestratorSynthesizerAgent {
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

  async run(options: OrchestratorSynthesisOptions): Promise<OrchestratorSynthesisResult> {
    const { skill, document, proposals, agentId, actor, runId, signal } = options;
    const config = getAgentConfig();

    if (!config.apiKey) {
      throw new Error(
        'Anthropic API key not configured. Call setApiKey() before running synthesis.'
      );
    }

    const deduped = dedupeProposals(proposals, document);
    const startedAt = Date.now();
    updateSynthesisDebugState({
      status: 'running',
      proposalsReceived: proposals.length,
      proposalsConsidered: deduped.proposals.length,
      duplicatesRemoved: deduped.duplicatesRemoved,
      truncated: deduped.truncated,
      invalidRemoved: deduped.invalidRemoved,
      invalidReasons: deduped.invalidReasons,
      toolCalls: 0,
      appliedSuggestionCount: 0,
      appliedCommentCount: 0,
      toolNames: [],
      toolErrors: [],
      startedAt,
      finishedAt: null,
      error: null,
      rawTextPreview: '',
    });
    if (deduped.proposals.length === 0) {
      const finishedAt = Date.now();
      updateSynthesisDebugState({
        status: 'completed',
        proposalsReceived: proposals.length,
        proposalsConsidered: 0,
        duplicatesRemoved: deduped.duplicatesRemoved,
        truncated: deduped.truncated,
        invalidRemoved: deduped.invalidRemoved,
        invalidReasons: deduped.invalidReasons,
        toolCalls: 0,
        appliedSuggestionCount: 0,
        appliedCommentCount: 0,
        toolNames: [],
        toolErrors: [],
        startedAt,
        finishedAt,
        error: null,
        rawTextPreview: '',
      });
      return {
        status: 'completed',
        proposalsReceived: proposals.length,
        proposalsConsidered: 0,
        duplicatesRemoved: deduped.duplicatesRemoved,
        truncated: deduped.truncated,
        invalidRemoved: deduped.invalidRemoved,
        invalidReasons: deduped.invalidReasons,
        appliedSuggestionCount: 0,
        appliedCommentCount: 0,
        toolCalls: 0,
      };
    }

    const systemPrompt = buildSynthesisPrompt(skill, document, deduped, proposals.length);
    const tools = getHttpBridgeTools({ agentId, actor, signal, mode: 'apply', runId });
    const anthropicTools = convertToolsToAnthropicFormat(tools);
    const toolHandlers = new Map<string, AgentTool['handler']>(
      tools.map((tool) => [tool.name, tool.handler])
    );

    const messages: MessageParam[] = [{ role: 'user', content: 'Synthesize and apply the proposed changes.' }];
    let toolCalls = 0;
    let rawText = '';
    let appliedSuggestionCount = 0;
    let appliedCommentCount = 0;
    const toolNames: string[] = [];
    const toolErrors: string[] = [];

    let finalStatus: OrchestratorSynthesisResult['status'] = 'completed';
    let finalError: string | undefined;
    let completedNormally = false;

    try {
      for (let iteration = 0; iteration < SYNTHESIS_MAX_ITERATIONS; iteration += 1) {
        throwIfAborted(signal);

        const client = this.getClient(config.apiKey);
        const result = await runWithRetry(
          () =>
            withTimeout(
              client.messages.create({
                model: SYNTHESIS_MODEL,
                max_tokens: SYNTHESIS_MAX_TOKENS,
                system: systemPrompt,
                tools: anthropicTools,
                messages,
                signal,
              }),
              SYNTHESIS_REQUEST_TIMEOUT_MS,
              'Synthesis request'
            ),
          signal
        );

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
          completedNormally = true;
          break;
        }

        messages.push({ role: 'assistant', content: result.content as ContentBlockParam[] });

        const toolResults: ToolResultBlockParam[] = [];
        for (const toolBlock of toolUseBlocks) {
          throwIfAborted(signal);
          toolCalls += 1;

          const handler = toolHandlers.get(toolBlock.name);
          const toolResult = handler
            ? await handler(toolBlock.input as Record<string, unknown>)
            : { success: false, error: `Unknown tool: ${toolBlock.name}` };

          toolNames.push(toolBlock.name);
          const toolError = extractToolError(toolResult);
          if (toolError && toolErrors.length < 10) {
            toolErrors.push(`${toolBlock.name}: ${toolError}`);
          }

          if (!isToolFailure(toolResult)) {
            if (toolBlock.name === 'create_suggestion') {
              appliedSuggestionCount += 1;
            } else if (toolBlock.name === 'add_comment') {
              appliedCommentCount += 1;
            }
          }

          toolResults.push({
            type: 'tool_result',
            tool_use_id: toolBlock.id,
            content: JSON.stringify(toolResult),
          });
        }

        messages.push({ role: 'user', content: toolResults });

        if (result.stop_reason === 'end_turn' || result.stop_reason === 'stop_sequence') {
          completedNormally = true;
          break;
        }
      }

      if (!completedNormally) {
        throw new Error('Orchestrator synthesis iteration limit reached');
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      if (signal?.aborted || errorMessage.toLowerCase().includes('cancel')) {
        finalStatus = 'cancelled';
      } else {
        finalStatus = 'error';
        finalError = errorMessage;
        console.error('[OrchestratorSynthesizerAgent] Failed to synthesize proposals:', error);
      }
    }

    const finishedAt = Date.now();
    const rawTextPreview = rawText.slice(0, 200);
    updateSynthesisDebugState({
      status: finalStatus,
      proposalsReceived: proposals.length,
      proposalsConsidered: deduped.proposals.length,
      duplicatesRemoved: deduped.duplicatesRemoved,
      truncated: deduped.truncated,
      invalidRemoved: deduped.invalidRemoved,
      invalidReasons: deduped.invalidReasons,
      toolCalls,
      appliedSuggestionCount,
      appliedCommentCount,
      toolNames: toolNames.slice(-25),
      toolErrors,
      startedAt,
      finishedAt,
      error: finalError ?? null,
      rawTextPreview,
    });

    return {
      status: finalStatus,
      proposalsReceived: proposals.length,
      proposalsConsidered: deduped.proposals.length,
      duplicatesRemoved: deduped.duplicatesRemoved,
      truncated: deduped.truncated,
      invalidRemoved: deduped.invalidRemoved,
      invalidReasons: deduped.invalidReasons,
      appliedSuggestionCount,
      appliedCommentCount,
      toolCalls,
      error: finalError,
      rawText: rawText || undefined,
    };
  }
}

export const orchestratorSynthesizerAgent = new OrchestratorSynthesizerAgent();
