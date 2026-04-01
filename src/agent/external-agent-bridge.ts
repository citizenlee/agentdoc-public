import { getSessionManager, type AgentSessionStatus } from './session-manager';

const externalClearTimers = new Map<string, ReturnType<typeof setTimeout>>();
const externalIdleTimers = new Map<string, ReturnType<typeof setTimeout>>();
const externalStaleTimers = new Map<string, ReturnType<typeof setTimeout>>();
const externalLastSeen = new Map<string, number>();
const externalLastTimestamp = new Map<string, number>();

const externalIdleMs = 30000;
const externalStaleMs = 120000;
const externalCompletedRetentionMs = 120000;

function getExternalSessionId(agentId: string): string {
  return `external-${agentId}`;
}

function pruneDuplicateExternalSessions(agentId: string, keepSessionId: string): void {
  const sessionManager = getSessionManager();
  const prompt = `External agent: ${agentId}`;

  sessionManager.getAllSessions().forEach((session) => {
    if (session.id === keepSessionId) return;
    if (session.skill === agentId || session.prompt === prompt) {
      void sessionManager.discardSession(session.id);
    }
  });
}

function summaryForOperation(operation?: string): string {
  switch (operation) {
    case 'marks/comment':
      return 'Adding comment';
    case 'marks/reply':
      return 'Replying to comment';
    case 'marks/resolve':
      return 'Resolving comment';
    case 'marks/unresolve':
      return 'Reopening comment';
    case 'marks/suggest-insert':
      return 'Suggesting insert';
    case 'marks/suggest-delete':
      return 'Suggesting delete';
    case 'marks/suggest-replace':
      return 'Suggesting replace';
    case 'marks/suggest-edit':
      return 'Suggesting edits';
    case 'marks/accept':
      return 'Accepting suggestion';
    case 'marks/reject':
      return 'Rejecting suggestion';
    case 'marks/accept-all':
      return 'Accepting suggestions';
    case 'marks/reject-all':
      return 'Rejecting suggestions';
    case 'marks/modify-suggestion':
      return 'Updating suggestion';
    case 'marks/approve':
      return 'Approving text';
    case 'marks/unapprove':
      return 'Removing approval';
    case 'marks/flag':
      return 'Flagging text';
    case 'marks/unflag':
      return 'Removing flag';
    case 'marks/delete':
      return 'Deleting mark';
    default:
      return 'Working';
  }
}

function scheduleIdleTimer(sessionId: string): void {
  const existing = externalIdleTimers.get(sessionId);
  if (existing) clearTimeout(existing);

  const timer = setTimeout(() => {
    const lastSeen = externalLastSeen.get(sessionId) ?? 0;
    if (Date.now() - lastSeen < externalIdleMs) return;
    const sessionManager = getSessionManager();
    const session = sessionManager.getSession(sessionId);
    if (!session) return;
    sessionManager.updateSessionStatus(sessionId, 'waiting', { message: 'Idle...' });
  }, externalIdleMs);

  externalIdleTimers.set(sessionId, timer);
}

function scheduleStaleTimer(sessionId: string): void {
  const existing = externalStaleTimers.get(sessionId);
  if (existing) clearTimeout(existing);

  const timer = setTimeout(() => {
    const lastSeen = externalLastSeen.get(sessionId) ?? 0;
    if (Date.now() - lastSeen < externalStaleMs) return;
    const sessionManager = getSessionManager();
    void sessionManager.discardSession(sessionId);
  }, externalStaleMs);

  externalStaleTimers.set(sessionId, timer);
}

function clearPendingClear(sessionId: string): void {
  const existing = externalClearTimers.get(sessionId);
  if (existing) {
    clearTimeout(existing);
    externalClearTimers.delete(sessionId);
  }
}

function clearAllTimersForSession(sessionId: string): void {
  clearPendingClear(sessionId);

  const idleTimer = externalIdleTimers.get(sessionId);
  if (idleTimer) {
    clearTimeout(idleTimer);
    externalIdleTimers.delete(sessionId);
  }

  const staleTimer = externalStaleTimers.get(sessionId);
  if (staleTimer) {
    clearTimeout(staleTimer);
    externalStaleTimers.delete(sessionId);
  }
}

export async function updateExternalAgentPresence(data: {
  agentId: string;
  status: AgentSessionStatus;
  summary?: string;
  operation?: string;
  position?: number;
  timestamp?: number;
}): Promise<void> {
  const sessionManager = getSessionManager();
  const sessionId = getExternalSessionId(data.agentId);

  const incomingTimestamp = data.timestamp ?? Date.now();
  const lastTimestamp = externalLastTimestamp.get(sessionId);
  if (lastTimestamp !== undefined && incomingTimestamp < lastTimestamp) {
    return;
  }
  externalLastTimestamp.set(sessionId, incomingTimestamp);

  clearPendingClear(sessionId);

  let session = sessionManager.getSession(sessionId);
  if (!session) {
    session = await sessionManager.createSession({
      sessionId,
      bypassConcurrencyLimit: true,
      prompt: `External agent: ${data.agentId}`,
      skill: data.agentId,
    });
  }

  pruneDuplicateExternalSessions(data.agentId, sessionId);

  const message = data.summary ?? summaryForOperation(data.operation);
  sessionManager.updateSessionStatus(sessionId, data.status, { message });

  if (data.position !== undefined) {
    sessionManager.updatePosition(sessionId, data.position);
  }

  externalLastSeen.set(sessionId, Date.now());
  scheduleIdleTimer(sessionId);
  scheduleStaleTimer(sessionId);
}

export async function upsertExternalAgentSession(data: {
  agentId: string;
  status: AgentSessionStatus;
  operation?: string;
  position?: number;
}): Promise<void> {
  await updateExternalAgentPresence({
    agentId: data.agentId,
    status: data.status,
    operation: data.operation,
    summary: summaryForOperation(data.operation),
    position: data.position,
    timestamp: Date.now(),
  });
}

export function clearExternalAgentSession(
  data: { agentId: string; timestamp?: number } | string
): void {
  const payload = typeof data === 'string' ? { agentId: data } : data;
  const sessionId = getExternalSessionId(payload.agentId);
  const clearTimestamp = payload.timestamp ?? Date.now();
  const lastTimestamp = externalLastTimestamp.get(sessionId);
  if (lastTimestamp !== undefined && clearTimestamp < lastTimestamp) {
    return;
  }

  externalLastTimestamp.set(sessionId, clearTimestamp);
  clearAllTimersForSession(sessionId);

  const sessionManager = getSessionManager();
  const session = sessionManager.getSession(sessionId);
  if (!session) return;

  sessionManager.updateSessionStatus(sessionId, 'completed', {
    message: session.currentThinking || 'Completed',
  });

  const timer = setTimeout(() => {
    const currentLastTimestamp = externalLastTimestamp.get(sessionId);
    if (currentLastTimestamp !== undefined && currentLastTimestamp > clearTimestamp) {
      return;
    }
    void sessionManager.discardSession(sessionId);
  }, externalCompletedRetentionMs);

  externalClearTimers.set(sessionId, timer);
}

const hooks = {
  updateExternalAgentPresence,
  upsertExternalAgentSession,
  clearExternalAgentSession,
};

(window as any).__agentdocExternalAgentHooks = hooks;
if ((window as any).agentdoc) {
  Object.assign((window as any).agentdoc, hooks);
}
