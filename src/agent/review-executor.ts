import type { EditorView } from '@milkdown/kit/prose/view';
import type { Skill } from './skills/registry';

export type ReviewScope = 'selection' | 'document';

export interface OrchestrationRunOptions {
  focusAreaIds?: string[];
  maxFocusAreas?: number;
  singleWriter?: boolean;
  visibleProvisionalMarks?: boolean;
  markStrategy?: 'propose' | 'visible-provisional';
  useGlobalConfig?: boolean;
}

export async function runReview(
  _view: EditorView,
  _skill: Skill,
  _scope: ReviewScope,
  _selection?: { from: number; to: number },
  _options?: OrchestrationRunOptions,
): Promise<{ success: false; reason: string }> {
  return {
    success: false,
    reason: 'Embedded review execution is not bundled with Agentdoc SDK. Use the HTTP bridge with your own agent provider.',
  };
}

export async function cancelActiveReview(): Promise<void> {}

export async function debugPlanOnly(
  _view: EditorView,
  skill: Skill,
  _options?: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  return {
    success: false,
    skillId: skill.id,
    reason: 'Embedded review planning is not bundled with Agentdoc SDK.',
  };
}

export async function debugRunSingleFocusArea(
  _view: EditorView,
  skill: Skill,
  _options?: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  return {
    success: false,
    skillId: skill.id,
    reason: 'Embedded review execution is not bundled with Agentdoc SDK.',
  };
}

export function debugGetCachedPlan(skillId: string): Record<string, unknown> {
  return {
    success: false,
    skillId,
    reason: 'No embedded review planner is active.',
  };
}

export function debugClearPlanCache(_skillId?: string): void {}
