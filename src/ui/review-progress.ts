import type { FocusArea } from '../agent/orchestrator';

export type ReviewProgressMode = 'orchestrated' | 'fallback';
export type ReviewProgressStatus = 'running' | 'completed' | 'cancelled' | 'error';
export type ReviewFocusStatus = 'pending' | 'running' | 'completed' | 'cancelled' | 'error';
export type OrchestratorStatus = 'running' | 'completed' | 'error';

export interface ReviewProgressFocusArea {
  id: string;
  name: string;
  status: ReviewFocusStatus;
  agentId?: string;
  suggestionCount?: number;
  error?: string;
  message?: string;
}

export interface ReviewProgressSnapshot {
  skillName: string;
  runId: string;
  mode: ReviewProgressMode;
  status: ReviewProgressStatus;
  orchestrator: {
    status: OrchestratorStatus;
    reasoning?: string;
    focusAreaCount?: number;
    error?: string;
  };
  focusAreas: ReviewProgressFocusArea[];
  fallbackReason?: string;
  updatedAt: number;
}

const COMPLETED_RETENTION_MS = 120000;

let currentProgress: ReviewProgressSnapshot | null = null;
let clearTimer: ReturnType<typeof setTimeout> | null = null;

// Debug hook: allows /eval to read the current progress snapshot.
if (typeof window !== 'undefined') {
  (window as Window & { __agentdocReviewProgress?: { get: () => ReviewProgressSnapshot | null } }).__agentdocReviewProgress = {
    get: () => currentProgress,
  };
}

function cancelClearTimer(): void {
  if (!clearTimer) return;
  clearTimeout(clearTimer);
  clearTimer = null;
}

function emitProgressUpdate(): void {
  // Intentionally no-op: the native sidebar should only show agent sessions.
}

function updateProgress(
  runId: string | null,
  mutator: (progress: ReviewProgressSnapshot) => ReviewProgressSnapshot
): void {
  if (!currentProgress) return;
  if (runId && currentProgress.runId !== runId) return;
  currentProgress = mutator(currentProgress);
  emitProgressUpdate();
}

function scheduleClearIfTerminal(progress: ReviewProgressSnapshot): void {
  if (progress.status === 'running') return;
  cancelClearTimer();
  const snapshotUpdatedAt = progress.updatedAt;
  const snapshotRunId = progress.runId;
  clearTimer = setTimeout(() => {
    if (!currentProgress) return;
    if (currentProgress.runId !== snapshotRunId) return;
    if (currentProgress.updatedAt !== snapshotUpdatedAt) return;
    clearReviewProgress(snapshotRunId);
  }, COMPLETED_RETENTION_MS);
}

function markUpdated(progress: ReviewProgressSnapshot): ReviewProgressSnapshot {
  return { ...progress, updatedAt: Date.now() };
}

function isTerminalStatus(status: ReviewFocusStatus): boolean {
  return status === 'completed' || status === 'cancelled' || status === 'error';
}

function recomputeAggregateStatus(progress: ReviewProgressSnapshot): ReviewProgressSnapshot {
  if (progress.status !== 'running') return progress;
  if (progress.focusAreas.length === 0) return progress;

  const statuses = progress.focusAreas.map((area) => area.status);
  const allTerminal = statuses.every(isTerminalStatus);
  if (!allTerminal) return progress;

  const hasError = statuses.includes('error');
  const hasCancelled = statuses.includes('cancelled');
  // Only auto-complete when every focus area completed successfully.
  // If there are errors/cancellations, the executor will set the final status.
  if (hasError || hasCancelled) {
    return progress;
  }

  const updated = markUpdated({ ...progress, status: 'completed' });
  scheduleClearIfTerminal(updated);
  return updated;
}

export function startOrchestratedProgress(runId: string, skillName: string, focusAreas: FocusArea[]): void {
  cancelClearTimer();
  const now = Date.now();
  currentProgress = {
    skillName,
    runId,
    mode: 'orchestrated',
    status: 'running',
    orchestrator: {
      status: 'running',
      focusAreaCount: focusAreas.length,
    },
    focusAreas: focusAreas.map((area) => ({
      id: area.id,
      name: area.name,
      status: 'pending',
    })),
    updatedAt: now,
  };
  emitProgressUpdate();
}

export function setOrchestratedFocusAreas(runId: string, focusAreas: FocusArea[]): void {
  updateProgress(runId, (progress) => {
    if (progress.status !== 'running') return progress;
    const existingById = new Map(progress.focusAreas.map((area) => [area.id, area]));
    const nextFocusAreas = focusAreas.map((area) => {
      const existing = existingById.get(area.id);
      return {
        id: area.id,
        name: area.name,
        status: existing?.status ?? 'pending',
        agentId: existing?.agentId,
        suggestionCount: existing?.suggestionCount,
        error: existing?.error,
        message: existing?.message,
      };
    });

    return markUpdated({
      ...progress,
      focusAreas: nextFocusAreas,
      orchestrator: {
        ...progress.orchestrator,
        focusAreaCount: focusAreas.length,
      },
    });
  });
}

export function markOrchestratorComplete(runId: string, reasoning: string, focusAreaCount: number): void {
  updateProgress(runId, (progress) => {
    if (progress.status !== 'running') return progress;
    return markUpdated({
      ...progress,
      orchestrator: {
        ...progress.orchestrator,
        status: 'completed',
        reasoning,
        focusAreaCount,
        error: undefined,
      },
    });
  });
}

export function markOrchestratorError(runId: string, error: string): void {
  updateProgress(runId, (progress) => {
    if (progress.status !== 'running') return progress;
    return markUpdated({
      ...progress,
      orchestrator: {
        ...progress.orchestrator,
        status: 'error',
        error,
      },
    });
  });
}

export function markFallback(runId: string, reason: string): void {
  updateProgress(runId, (progress) => {
    if (progress.status !== 'running') return progress;
    return markUpdated({
      ...progress,
      mode: 'fallback',
      fallbackReason: reason,
    });
  });
}

export function updateFocusAreaStatus(
  runId: string,
  focusAreaId: string,
  status: ReviewFocusStatus,
  options: {
    suggestionCount?: number;
    error?: string;
    agentId?: string;
    message?: string;
  } = {}
): void {
  updateProgress(runId, (progress) => {
    if (progress.status !== 'running') return progress;
    let didUpdate = false;
    const focusAreas = progress.focusAreas.map((area) => {
      if (area.id !== focusAreaId) return area;
      didUpdate = true;
      return {
        ...area,
        status,
        suggestionCount: options.suggestionCount ?? area.suggestionCount,
        error: options.error,
        agentId: options.agentId ?? area.agentId,
        message: options.message ?? area.message,
      };
    });

    if (!didUpdate) return progress;
    const updated = markUpdated({ ...progress, focusAreas });
    return recomputeAggregateStatus(updated);
  });
}

export function markReviewCompleted(runId: string): void {
  updateProgress(runId, (progress) => {
    if (progress.status !== 'running') return progress;
    const updated = markUpdated({ ...progress, status: 'completed' });
    scheduleClearIfTerminal(updated);
    return updated;
  });
}

export function markReviewCancelled(runId: string): void {
  updateProgress(runId, (progress) => {
    if (progress.status !== 'running') return progress;
    const focusAreas = progress.focusAreas.map((area) =>
      isTerminalStatus(area.status) ? area : { ...area, status: 'cancelled' }
    );
    const updated = markUpdated({ ...progress, status: 'cancelled', focusAreas });
    scheduleClearIfTerminal(updated);
    return updated;
  });
}

export function markReviewError(runId: string, error: string): void {
  updateProgress(runId, (progress) => {
    if (progress.status !== 'running') return progress;
    const updated = markUpdated({
      ...progress,
      status: 'error',
      orchestrator: {
        ...progress.orchestrator,
        error,
      },
    });
    scheduleClearIfTerminal(updated);
    return updated;
  });
}

export function clearReviewProgress(runId?: string): void {
  if (runId && currentProgress && currentProgress.runId !== runId) {
    return;
  }
  cancelClearTimer();
  currentProgress = null;
  emitProgressUpdate();
}

export function getReviewProgressSnapshot(): ReviewProgressSnapshot | null {
  return currentProgress;
}
