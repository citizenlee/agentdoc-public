type AgentStatusGetter = () => {
  status: string;
  sessionId?: string;
};

type SessionManagerFactory = (config?: { persistenceKey?: string }) => {
  createSession: (options: { sessionId: string; prompt: string; skill?: string }) => Promise<{
    status: string;
    lastActivity: Date;
  }>;
};

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

async function testPrefersMostRecentCompletedSession(): Promise<void> {
  const { getAgentStatus, initSessionManager } = await loadAgentModules();
  const manager = initSessionManager({
    persistenceKey: `agent-status-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  });

  const stale = await manager.createSession({
    sessionId: 'stale-session',
    prompt: 'stale',
    skill: 'Agentdoc',
  });
  stale.status = 'completed';
  stale.lastActivity = new Date(1_000);

  const fresh = await manager.createSession({
    sessionId: 'fresh-session',
    prompt: 'fresh',
    skill: 'Agentdoc',
  });
  fresh.status = 'completed';
  fresh.lastActivity = new Date(2_000);

  const status = getAgentStatus();
  assert(status.sessionId === 'fresh-session', `Expected fresh-session, got ${status.sessionId ?? 'none'}`);
  assert(status.status === 'completed', `Expected completed status, got ${status.status}`);
}

async function testPrefersMostRecentRunningSession(): Promise<void> {
  const { getAgentStatus, initSessionManager } = await loadAgentModules();
  const manager = initSessionManager({
    persistenceKey: `agent-status-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  });

  const stale = await manager.createSession({
    sessionId: 'stale-running',
    prompt: 'stale',
    skill: 'Agentdoc',
  });
  stale.status = 'thinking';
  stale.lastActivity = new Date(1_000);

  const fresh = await manager.createSession({
    sessionId: 'fresh-running',
    prompt: 'fresh',
    skill: 'Agentdoc',
  });
  fresh.status = 'acting';
  fresh.lastActivity = new Date(3_000);

  const status = getAgentStatus();
  assert(status.sessionId === 'fresh-running', `Expected fresh-running, got ${status.sessionId ?? 'none'}`);
  assert(status.status === 'running', `Expected running status, got ${status.status}`);
}

async function run(): Promise<void> {
  await testPrefersMostRecentCompletedSession();
  await testPrefersMostRecentRunningSession();
  console.log('agent-status.test.ts passed');
}

async function loadAgentModules(): Promise<{
  getAgentStatus: AgentStatusGetter;
  initSessionManager: SessionManagerFactory;
}> {
  (globalThis as { window?: unknown }).window = {
    webkit: undefined,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  };
  (globalThis as { localStorage?: Storage }).localStorage = {
    getItem: () => null,
    setItem: () => undefined,
    removeItem: () => undefined,
    clear: () => undefined,
    key: () => null,
    length: 0,
  };

  const agent = await import('../agent/index');
  const sessionManager = await import('../agent/session-manager');
  return {
    getAgentStatus: agent.getAgentStatus as AgentStatusGetter,
    initSessionManager: sessionManager.initSessionManager as SessionManagerFactory,
  };
}

run().catch((error) => {
  console.error('agent-status.test.ts failed');
  console.error(error);
  process.exit(1);
});
