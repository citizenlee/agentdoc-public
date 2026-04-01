import type { AgentResponse, ThinkingChainEvent } from './types';

export type AgentSessionStatus =
  | 'idle'
  | 'reading'
  | 'thinking'
  | 'acting'
  | 'waiting'
  | 'completed'
  | 'cancelled'
  | 'error'
  | 'interrupted';

export interface AgentSession {
  id: string;
  status: AgentSessionStatus;
  skill: string | null;
  prompt: string;
  currentThinking: string;
  documentPosition: number | null;
  startTime: Date;
  lastActivity: Date;
  tokensUsed: number;
  estimatedCost: number;
  thinkingChain: ThinkingChainEvent[];
  response: AgentResponse | null;
  error: string | null;
}

export interface SessionManagerConfig {
  maxConcurrentAgents: number;
  tokenBudgetPerSession: number;
  persistenceKey: string;
  onSessionChange?: (sessions: AgentSession[]) => void;
  onPositionChange?: (sessionId: string, position: number) => void;
}

export class AgentSessionManager {
  private sessions = new Map<string, AgentSession>();
  private changeListeners = new Set<(sessions: AgentSession[]) => void>();
  private positionListeners = new Map<string, Set<(position: number) => void>>();
  private config: SessionManagerConfig;

  constructor(config: Partial<SessionManagerConfig> = {}) {
    this.config = {
      maxConcurrentAgents: config.maxConcurrentAgents ?? 5,
      tokenBudgetPerSession: config.tokenBudgetPerSession ?? 50000,
      persistenceKey: config.persistenceKey ?? 'agentdoc-agent-sessions',
      onSessionChange: config.onSessionChange,
      onPositionChange: config.onPositionChange,
    };
  }

  async createSession(options: {
    prompt: string;
    skill?: string;
    sessionId?: string;
    bypassConcurrencyLimit?: boolean;
  }): Promise<AgentSession> {
    if (options.sessionId) {
      const existing = this.sessions.get(options.sessionId);
      if (existing) return existing;
    }

    const now = new Date();
    const sessionId = options.sessionId ?? `session-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const session: AgentSession = {
      id: sessionId,
      status: 'idle',
      skill: options.skill ?? null,
      prompt: options.prompt,
      currentThinking: '',
      documentPosition: null,
      startTime: now,
      lastActivity: now,
      tokensUsed: 0,
      estimatedCost: 0,
      thinkingChain: [],
      response: null,
      error: null,
    };
    this.sessions.set(sessionId, session);
    this.broadcastUpdate();
    return session;
  }

  getSession(sessionId: string): AgentSession | undefined {
    return this.sessions.get(sessionId);
  }

  getAllSessions(): AgentSession[] {
    return Array.from(this.sessions.values());
  }

  getActiveSessions(): AgentSession[] {
    return this.getAllSessions().filter(
      (session) => ['reading', 'thinking', 'acting', 'waiting'].includes(session.status),
    );
  }

  updateSessionStatus(
    sessionId: string,
    status: AgentSessionStatus,
    options: { message?: string } = {},
  ): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    session.status = status;
    session.lastActivity = new Date();
    if (options.message !== undefined) {
      session.currentThinking = options.message;
    }
    if (status === 'error') {
      session.error = options.message ?? session.error;
    } else if (status !== 'interrupted') {
      session.error = null;
    }
    this.broadcastUpdate();
  }

  updatePosition(sessionId: string, position: number): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    session.documentPosition = position;
    session.lastActivity = new Date();
    const listeners = this.positionListeners.get(sessionId);
    if (listeners) {
      listeners.forEach((listener) => listener(position));
    }
    this.config.onPositionChange?.(sessionId, position);
    this.broadcastUpdate();
  }

  async cancelSession(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    session.status = 'cancelled';
    session.lastActivity = new Date();
    this.broadcastUpdate();
  }

  async resumeSession(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session || session.status !== 'interrupted') return;
    session.status = 'idle';
    session.lastActivity = new Date();
    this.broadcastUpdate();
  }

  async discardSession(sessionId: string): Promise<void> {
    this.positionListeners.delete(sessionId);
    this.sessions.delete(sessionId);
    this.broadcastUpdate();
  }

  onSessionChange(callback: (sessions: AgentSession[]) => void): () => void {
    this.changeListeners.add(callback);
    callback(this.getAllSessions());
    return () => {
      this.changeListeners.delete(callback);
    };
  }

  onPositionChange(sessionId: string, callback: (position: number) => void): () => void {
    if (!this.positionListeners.has(sessionId)) {
      this.positionListeners.set(sessionId, new Set());
    }
    const listeners = this.positionListeners.get(sessionId)!;
    listeners.add(callback);
    return () => {
      listeners.delete(callback);
      if (listeners.size === 0) {
        this.positionListeners.delete(sessionId);
      }
    };
  }

  private broadcastUpdate(): void {
    const sessions = this.getAllSessions();
    this.changeListeners.forEach((listener) => listener(sessions));
    this.config.onSessionChange?.(sessions);
  }
}

let sessionManager: AgentSessionManager | null = null;

export function initSessionManager(config?: Partial<SessionManagerConfig>): AgentSessionManager {
  sessionManager = new AgentSessionManager(config);
  return sessionManager;
}

export function getSessionManager(): AgentSessionManager {
  if (!sessionManager) {
    sessionManager = new AgentSessionManager();
  }
  return sessionManager;
}
