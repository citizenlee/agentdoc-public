import { getSessionManager } from './session-manager';
import type { AgentStatus, AgentStatusInfo } from './types';

export type AgentSessionSummary = {
  id: string;
  status: string;
  currentThinking: string;
  tokensUsed: number;
  estimatedCost: number;
};

export function getAgentStatus(): AgentStatusInfo {
  const hasActive = getSessionManager().getActiveSessions().length > 0;
  const status: AgentStatus = hasActive ? 'running' : 'offline';
  return { status };
}

export function getAgentSessionsSummary(): AgentSessionSummary[] {
  return getSessionManager().getAllSessions().map((session) => ({
    id: session.id,
    status: session.status,
    currentThinking: session.currentThinking,
    tokensUsed: session.tokensUsed,
    estimatedCost: session.estimatedCost,
  }));
}

export async function cancelAllAgentSessions(): Promise<{ count: number }> {
  const manager = getSessionManager();
  const sessions = manager.getAllSessions();
  for (const session of sessions) {
    await manager.cancelSession(session.id);
    await manager.discardSession(session.id);
  }
  return { count: sessions.length };
}
