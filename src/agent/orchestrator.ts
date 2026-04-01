import Anthropic from '@anthropic-ai/sdk';
import type { TextBlock } from '@anthropic-ai/sdk/resources/messages';
import { getAgentConfig } from './config';
import type { Skill } from './skills/registry';

export interface FocusArea {
  id: string;
  name: string;
  systemPrompt: string;
}

export interface ExecutionPlan {
  focusAreas: FocusArea[];
  reasoning: string;
}

export interface OrchestratorResult {
  plan: ExecutionPlan | null;
  rawResponse: string;
  fallbackReason?: string;
}

export const ORCHESTRATOR_MODEL = 'claude-opus-4-5-20251101';
const ORCHESTRATOR_MAX_TOKENS = 8192;
const ORCHESTRATOR_DOCUMENT_CHAR_LIMIT = 20_000;
const ORCHESTRATOR_MAX_ATTEMPTS = 2;
const ORCHESTRATOR_REQUEST_TIMEOUT_MS = 120_000;
const ORCHESTRATOR_MAX_RETRIES = 1;
const ORCHESTRATOR_RETRY_BASE_DELAY_MS = 1_500;
const ORCHESTRATOR_RETRY_USER_MESSAGE = 'The previous tool call was invalid or empty. Call submit_plan with a non-empty focusAreas array.';
const LARGE_DOCUMENT_CHAR_THRESHOLD = 8_000;
const ORCHESTRATOR_DEFAULT_FOCUS_AREA_LIMIT = 10;
const FOCUS_AREA_ID_CHAR_LIMIT = 80;
const FOCUS_AREA_NAME_CHAR_LIMIT = 120;
const FOCUS_AREA_PROMPT_CHAR_LIMIT = 1_200;

const SUBMIT_PLAN_TOOL = {
  name: 'submit_plan',
  description: 'Submit the orchestrated review plan as structured data.',
  input_schema: {
    type: 'object',
    properties: {
      focusAreas: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            name: { type: 'string' },
            systemPrompt: { type: 'string' },
          },
          required: ['id', 'name', 'systemPrompt'],
        },
      },
      reasoning: { type: 'string' },
    },
    required: ['focusAreas'],
  },
} as const;

const SUBMIT_PLAN_TOOL_CHOICE = {
  type: 'tool',
  name: SUBMIT_PLAN_TOOL.name,
} as const;

type OrchestratorDebugStatus = 'idle' | 'requesting' | 'received' | 'parsed' | 'error';

interface OrchestratorDebugState {
  status: OrchestratorDebugStatus;
  model: string;
  startedAt: number | null;
  finishedAt: number | null;
  stopReason: string | null;
  toolUsed: boolean;
  toolFocusAreaCount: number | null;
  parsedFocusAreaCount: number;
  rawTextLength: number;
  rawTextPreview: string;
  error: string | null;
}

let orchestratorDebugState: OrchestratorDebugState = {
  status: 'idle',
  model: ORCHESTRATOR_MODEL,
  startedAt: null,
  finishedAt: null,
  stopReason: null,
  toolUsed: false,
  toolFocusAreaCount: null,
  parsedFocusAreaCount: 0,
  rawTextLength: 0,
  rawTextPreview: '',
  error: null,
};

function updateOrchestratorDebugState(patch: Partial<OrchestratorDebugState>): void {
  orchestratorDebugState = { ...orchestratorDebugState, ...patch };
}

if (typeof window !== 'undefined') {
  (window as Window & {
    __agentdocOrchestratorDebug?: { get: () => OrchestratorDebugState };
  }).__agentdocOrchestratorDebug = {
    get: () => orchestratorDebugState,
  };
}

const ORCHESTRATOR_PROMPT = `You are a review orchestrator. Your job is to split a review task into focused sub-tasks that can run in parallel.

## Tools Available To Sub-Agents

Sub-agents can use the following tools:
- read_document()
- search({ pattern, type })
- get_marks()
- propose_change({ kind, suggestionType, quote, content, text, rationale })

## Before Proposing Changes

Call get_marks() at most once per sub-agent run, and only when you expect existing marks.
In single-writer runs or clean documents, you can skip get_marks(); deduplication happens later.

If the text already has a suggestion:
- Same issue -> Do nothing (already handled)
- Different issue -> Propose a comment explaining your alternative
- Wrong fix -> Propose a comment explaining why it's wrong

Never duplicate existing suggestions or comments.

Sub-agents must NOT apply changes directly. They only propose changes via propose_change.
If the skill prompt mentions create_suggestion or add_comment, rewrite those instructions to use propose_change instead.

## Input

SKILL PROMPT:
{skillPrompt}

DOCUMENT:
{document}

## Your Task

1. Analyze the skill prompt to identify distinct, parallelizable concerns
2. For each concern, write a complete system prompt for a focused sub-agent
3. Each sub-agent should ONLY check their specific concern, not the whole skill

## Output Format

Return JSON:
{
  "focusAreas": [
    {
      "id": "unique-id",
      "name": "Human-readable name",
      "systemPrompt": "Complete system prompt for this sub-agent..."
    }
  ],
  "reasoning": "Why you chose these focus areas"
}

## Guidelines

Create a complete plan that covers the full skill prompt without inventing unrelated sections.

- Create between 1 and {focusAreaLimit} focus areas. Do not exceed {focusAreaLimit}.
- Each focus area should represent a single clear concern or closely related set of rules.
- Prioritize coverage over grouping: it is better to have more focused sub-agents than to miss rules.
- Make focus area ids short, stable, and kebab-case (for example: "capitalization-titles").
- Avoid overlapping scopes that would create conflicting suggestions.
- Each sub-agent's systemPrompt should include:
  - Their specific focus (what rules to check).
  - How to use the tools listed above.
  - Clear instructions to propose changes using propose_change instead of applying them.
  - Instructions to call read_style_guide() (if available) and read_document() once at the start.
  - Instructions to scan the entire document unless a narrower scope is required.
  - A concrete search strategy with example patterns or regexes to scan the document.
  - Conflict resolution instructions (check existing marks first).
- If a focus area is about structure (for example: headings, captions, or lists), say that small structural edits are allowed when required by the rule.
- When a rule has a common failure mode, include the critical detail explicitly (for example: punctuation should sit outside italics).
- Do NOT copy large portions of the skill prompt verbatim.
- Keep each systemPrompt concise and action-oriented. Avoid long preambles or repeating the full skill.
- Hard limits:
  - Each systemPrompt must be <= 1200 characters.
  - Each focus area name should be short (<= 120 characters).
  - reasoning must be <= 200 characters.`;

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new Error('Review cancelled');
  }
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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

function isRetryableError(message: string): boolean {
  const lower = message.toLowerCase();
  return lower.includes('overloaded')
    || lower.includes('rate limit')
    || lower.includes('529')
    || lower.includes('timeout')
    || lower.includes('timed out')
    || lower.includes('network')
    || lower.includes('-1001')
    || lower.includes('temporarily unavailable');
}

async function runWithRetry<T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  let attempt = 0;

  while (true) {
    throwIfAborted(signal);
    try {
      return await operation();
    } catch (error) {
      const message = toErrorMessage(error);
      if (!isRetryableError(message) || attempt >= ORCHESTRATOR_MAX_RETRIES) {
        throw error;
      }
      attempt += 1;
      const delayMs = ORCHESTRATOR_RETRY_BASE_DELAY_MS * attempt;
      await sleep(delayMs, signal);
    }
  }
}

async function executeWithTimeout<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  label: string,
  parentSignal?: AbortSignal
): Promise<T> {
  throwIfAborted(parentSignal);

  const attemptController = new AbortController();
  const onParentAbort = (): void => {
    const parentReason = parentSignal?.reason;
    if (parentReason instanceof Error) {
      attemptController.abort(parentReason);
      return;
    }
    if (typeof parentReason === 'string' && parentReason.trim()) {
      attemptController.abort(new Error(parentReason));
      return;
    }
    attemptController.abort(new Error('Review cancelled'));
  };

  if (parentSignal) {
    parentSignal.addEventListener('abort', onParentAbort, { once: true });
  }

  const timeoutId = setTimeout(() => {
    attemptController.abort(new Error(`${label} timed out after ${timeoutMs}ms`));
  }, timeoutMs);

  try {
    return await operation(attemptController.signal);
  } catch (error) {
    const abortReason = attemptController.signal.reason;
    if (attemptController.signal.aborted) {
      if (abortReason instanceof Error && abortReason.message) {
        throw abortReason;
      }
      if (typeof abortReason === 'string' && abortReason.trim()) {
        throw new Error(abortReason);
      }
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
    if (parentSignal) {
      parentSignal.removeEventListener('abort', onParentAbort);
    }
  }
}

function stripCodeFences(text: string): string {
  const trimmed = text.trim();
  if (!trimmed.startsWith('```')) return trimmed;
  return trimmed
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '')
    .trim();
}

function extractTextResponse(content: Anthropic.Message['content']): string {
  const textBlocks: string[] = [];
  for (const block of content) {
    if (block.type !== 'text') continue;
    textBlocks.push((block as TextBlock).text);
  }
  return textBlocks.join('\n').trim();
}

function extractToolInput(
  content: Anthropic.Message['content']
): { focusAreas?: unknown; reasoning?: unknown } | null {
  for (const block of content) {
    const toolUse = block as { type?: string; name?: string; input?: unknown };
    if (toolUse.type !== 'tool_use') continue;
    if (toolUse.name !== SUBMIT_PLAN_TOOL.name) continue;
    if (!toolUse.input || typeof toolUse.input !== 'object') continue;
    return toolUse.input as { focusAreas?: unknown; reasoning?: unknown };
  }
  return null;
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return '';
  }
}

function trimToLimit(value: string, limit: number): string {
  const trimmed = value.trim();
  if (trimmed.length <= limit) return trimmed;
  if (limit <= 3) return trimmed.slice(0, limit);
  return `${trimmed.slice(0, limit - 3).trimEnd()}...`;
}

function sanitizeFocusAreas(focusAreas: unknown, limit: number): FocusArea[] {
  if (!Array.isArray(focusAreas)) return [];

  const seenIds = new Set<string>();
  const areas: FocusArea[] = [];

  for (const area of focusAreas) {
    if (!area || typeof area !== 'object') continue;
    const idValue = (area as { id?: unknown }).id;
    const nameValue = (area as { name?: unknown }).name;
    const promptValue = (area as { systemPrompt?: unknown }).systemPrompt;
    if (typeof idValue !== 'string' || typeof nameValue !== 'string' || typeof promptValue !== 'string') {
      continue;
    }

    const id = trimToLimit(idValue, FOCUS_AREA_ID_CHAR_LIMIT).replace(/\s+/g, '-');
    const name = trimToLimit(nameValue, FOCUS_AREA_NAME_CHAR_LIMIT);
    const systemPrompt = trimToLimit(promptValue, FOCUS_AREA_PROMPT_CHAR_LIMIT);
    if (!id || !name || !systemPrompt) continue;

    let uniqueId = id;
    let counter = 2;
    while (seenIds.has(uniqueId)) {
      uniqueId = `${id}-${counter}`;
      counter += 1;
    }

    seenIds.add(uniqueId);
    areas.push({ id: uniqueId, name, systemPrompt });

    if (areas.length >= limit) break;
  }

  return areas;
}

function resolveFocusAreaLimit(skill: Skill, documentLength: number): number {
  const configuredLimit = typeof window !== 'undefined'
    ? (window as Window & {
        __AGENTDOC_CONFIG__?: { ORCHESTRATED_V4_MAX_FOCUS_AREAS?: number };
      }).__AGENTDOC_CONFIG__?.ORCHESTRATED_V4_MAX_FOCUS_AREAS
    : undefined;
  const skillLimit = typeof skill.maxAgents === 'number' && Number.isFinite(skill.maxAgents)
    ? Math.max(1, Math.floor(skill.maxAgents))
    : ORCHESTRATOR_DEFAULT_FOCUS_AREA_LIMIT;
  const configuredBound = typeof configuredLimit === 'number' && Number.isFinite(configuredLimit)
    ? Math.max(1, Math.floor(configuredLimit))
    : null;
  const bounded = configuredBound === null ? skillLimit : Math.min(skillLimit, configuredBound);
  if (documentLength > LARGE_DOCUMENT_CHAR_THRESHOLD) {
    return bounded;
  }
  return bounded;
}

export function buildDocumentContext(document: string): string {
  const normalized = document.trim();
  if (normalized.length <= ORCHESTRATOR_DOCUMENT_CHAR_LIMIT) {
    return normalized;
  }

  const excerpt = normalized.slice(0, ORCHESTRATOR_DOCUMENT_CHAR_LIMIT);
  return [
    `Document length: ${normalized.length} characters.`,
    `Only the first ${ORCHESTRATOR_DOCUMENT_CHAR_LIMIT} characters are included below.`,
    'Sub-agents can call read_document() to access the full document.',
    '',
    excerpt,
    '',
    '[Document truncated]',
  ].join('\n');
}

function buildOrchestratorPrompt(skill: Skill, document: string, focusAreaLimit: number): string {
  const documentContext = buildDocumentContext(document);
  const focusAreaLimitText = String(Math.max(1, Math.floor(focusAreaLimit)));
  return ORCHESTRATOR_PROMPT
    .replace('{skillPrompt}', () => skill.prompt)
    .replace('{focusAreaLimit}', () => focusAreaLimitText)
    .replace('{document}', () => documentContext);
}

export class OrchestratorAgent {
  private client: Anthropic | null = null;

  async run(skill: Skill, document: string, signal?: AbortSignal): Promise<OrchestratorResult> {
    // Check for static focus areas first - no LLM generation needed
    if (skill.focusAreas && skill.focusAreas.length > 0) {
      console.log(`[OrchestratorAgent] Using ${skill.focusAreas.length} static focus areas for skill: ${skill.id}`);
      updateOrchestratorDebugState({
        status: 'parsed',
        model: 'static',
        startedAt: Date.now(),
        finishedAt: Date.now(),
        stopReason: 'static_focus_areas',
        toolUsed: false,
        toolFocusAreaCount: skill.focusAreas.length,
        parsedFocusAreaCount: skill.focusAreas.length,
        rawTextLength: 0,
        rawTextPreview: 'Using static focus areas defined in skill',
        error: null,
      });
      return {
        plan: {
          focusAreas: skill.focusAreas.map(fa => ({
            id: fa.id,
            name: fa.name,
            systemPrompt: fa.systemPrompt,
          })),
          reasoning: `Static focus areas defined in skill: ${skill.focusAreas.map(fa => fa.id).join(', ')}`,
        },
        rawResponse: 'Static focus areas used - no LLM generation',
      };
    }

    // Fall back to LLM-generated focus areas
    const config = getAgentConfig();
    if (!config.apiKey) {
      throw new Error(
        'Anthropic API key not configured. Call setApiKey() before running the orchestrator.'
      );
    }

    const focusAreaLimit = resolveFocusAreaLimit(skill, document.length);
    const systemPrompt = buildOrchestratorPrompt(skill, document, focusAreaLimit);

    throwIfAborted(signal);

    const requestPlan = async (forceToolChoice: boolean, userMessage: string): Promise<Anthropic.Message> => {
      const toolChoicePart = forceToolChoice ? { tool_choice: SUBMIT_PLAN_TOOL_CHOICE } : {};
      const operation = async (attemptSignal: AbortSignal): Promise<Anthropic.Message> => {
        if (!this.client) {
          this.client = new Anthropic({
            apiKey: config.apiKey,
            dangerouslyAllowBrowser: true,
          });
        }

        return await this.client.messages.create({
          model: ORCHESTRATOR_MODEL,
          max_tokens: ORCHESTRATOR_MAX_TOKENS,
          system: systemPrompt,
          messages: [{ role: 'user', content: userMessage }],
          tools: [SUBMIT_PLAN_TOOL],
          ...toolChoicePart,
          signal: attemptSignal,
        });
      };

      return await runWithRetry(
        () => executeWithTimeout(operation, ORCHESTRATOR_REQUEST_TIMEOUT_MS, 'Orchestrator planning request', signal),
        signal
      );
    };

    let result: Anthropic.Message;
    updateOrchestratorDebugState({
      status: 'requesting',
      model: ORCHESTRATOR_MODEL,
      startedAt: Date.now(),
      finishedAt: null,
      stopReason: null,
      toolUsed: false,
      toolFocusAreaCount: null,
      parsedFocusAreaCount: 0,
      rawTextLength: 0,
      rawTextPreview: '',
      error: null,
    });
    try {
      result = await requestPlan(true, 'Create the review plan.');
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      updateOrchestratorDebugState({
        status: 'error',
        finishedAt: Date.now(),
        error: errorMessage,
      });
      throw error;
    }

    throwIfAborted(signal);

    let attempt = 1;
    let stopReason = result.stop_reason ?? null;
    let toolInput = extractToolInput(result.content);
    let rawText = extractTextResponse(result.content);
    let rawResponse = rawText || (toolInput ? safeStringify(toolInput) : '');

    while (true) {
      updateOrchestratorDebugState({
        status: 'received',
        stopReason,
        toolUsed: Boolean(toolInput),
        toolFocusAreaCount: Array.isArray(toolInput?.focusAreas) ? toolInput.focusAreas.length : null,
        rawTextLength: rawText.length,
        rawTextPreview: rawText.slice(0, 200),
      });

      let toolFocusAreasEmpty = false;
      if (toolInput) {
        const focusAreas = sanitizeFocusAreas(toolInput.focusAreas, focusAreaLimit);
        toolFocusAreasEmpty = focusAreas.length === 0;
        const reasoning = typeof toolInput.reasoning === 'string' ? toolInput.reasoning.trim() : '';
        if (focusAreas.length > 0) {
          updateOrchestratorDebugState({
            status: 'parsed',
            finishedAt: Date.now(),
            parsedFocusAreaCount: focusAreas.length,
          });
          return {
            plan: {
              focusAreas,
              reasoning,
            },
            rawResponse,
          };
        }
        console.warn('[OrchestratorAgent] Tool plan had no valid focus areas');
      }

      const shouldRetry = attempt < ORCHESTRATOR_MAX_ATTEMPTS
        && Boolean(toolInput)
        && toolFocusAreasEmpty
        && rawText.length === 0;

      if (!shouldRetry) {
        break;
      }

      attempt += 1;
      updateOrchestratorDebugState({
        status: 'requesting',
        stopReason: null,
        toolUsed: false,
        toolFocusAreaCount: null,
        parsedFocusAreaCount: 0,
        rawTextLength: 0,
        rawTextPreview: '',
        error: null,
      });

      try {
        result = await requestPlan(false, ORCHESTRATOR_RETRY_USER_MESSAGE);
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        updateOrchestratorDebugState({
          status: 'error',
          finishedAt: Date.now(),
          error: errorMessage,
        });
        throw error;
      }

      throwIfAborted(signal);
      stopReason = result.stop_reason ?? null;
      toolInput = extractToolInput(result.content);
      rawText = extractTextResponse(result.content);
      rawResponse = rawText || (toolInput ? safeStringify(toolInput) : '');
    }

    if (!rawText) {
      console.warn('[OrchestratorAgent] Empty response from orchestrator');
      const reason = stopReason === 'max_tokens'
        ? 'Orchestrator output was truncated at max_tokens'
        : toolInput
          ? 'Orchestrator submit_plan call was empty'
          : 'Orchestrator returned an empty response';
      updateOrchestratorDebugState({
        status: 'error',
        finishedAt: Date.now(),
        error: reason,
      });
      return {
        plan: null,
        rawResponse,
        fallbackReason: reason,
      };
    }

    const parseTarget = stripCodeFences(rawText);
    try {
      const parsed = JSON.parse(parseTarget) as { focusAreas?: unknown; reasoning?: unknown };
      const focusAreas = sanitizeFocusAreas(parsed.focusAreas, focusAreaLimit);
      if (focusAreas.length === 0) {
        console.warn('[OrchestratorAgent] Parsed plan had no valid focus areas');
        return {
          plan: null,
          rawResponse: rawText,
          fallbackReason: 'Orchestrator returned no focus areas',
        };
      }

      const reasoning = typeof parsed.reasoning === 'string' ? parsed.reasoning.trim() : '';
      return {
        plan: {
          focusAreas,
          reasoning,
        },
        rawResponse,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.warn('[OrchestratorAgent] Failed to parse plan JSON:', errorMessage);
      const reason = stopReason === 'max_tokens'
        ? `Orchestrator output was truncated at max_tokens: ${errorMessage}`
        : `Failed to parse orchestrator JSON: ${errorMessage}`;
      updateOrchestratorDebugState({
        status: 'error',
        finishedAt: Date.now(),
        error: reason,
      });
      return {
        plan: null,
        rawResponse,
        fallbackReason: reason,
      };
    }
  }
}

export const orchestratorAgent = new OrchestratorAgent();
