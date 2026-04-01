import type { AgentSession, AgentSessionStatus } from '../agent/session-manager';
import { captureEvent } from './telemetry';

const lastStatusBySessionId = new Map<string, AgentSessionStatus>();

function hashSessionId(value: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

export function syncAgentSessions(sessions: AgentSession[]): void {
  const visibleSessionIds = new Set<string>();
  for (const session of sessions) {
    visibleSessionIds.add(session.id);
    const previousStatus = lastStatusBySessionId.get(session.id);
    const skillName = session.skill ?? 'unknown';
    const sessionHash = hashSessionId(session.id);
    const isExternal = session.id.startsWith('external-');

    if (!previousStatus) {
      captureEvent('agent_session_started', {
        session_hash: sessionHash,
        status: session.status,
        skill_name: skillName,
        is_external: isExternal,
      });
    } else if (previousStatus !== session.status) {
      captureEvent('agent_session_status_changed', {
        session_hash: sessionHash,
        from_status: previousStatus,
        to_status: session.status,
        skill_name: skillName,
        is_external: isExternal,
      });

      if (['completed', 'cancelled', 'error', 'interrupted'].includes(session.status)) {
        captureEvent('agent_session_finished', {
          session_hash: sessionHash,
          final_status: session.status,
          skill_name: skillName,
          is_external: isExternal,
          had_error: Boolean(session.error),
        });
      }
    }

    lastStatusBySessionId.set(session.id, session.status);
  }

  for (const [sessionId, status] of lastStatusBySessionId) {
    if (visibleSessionIds.has(sessionId)) continue;
    captureEvent('agent_session_removed', {
      session_hash: hashSessionId(sessionId),
      last_status: status,
      is_external: sessionId.startsWith('external-'),
    });
    lastStatusBySessionId.delete(sessionId);
  }
}
