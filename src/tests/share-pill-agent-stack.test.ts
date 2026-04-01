type AgentStackToken =
  | { type: 'face'; agentId: string }
  | { type: 'overflow'; label: string };

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

function buildStackTokens(agentIds: string[]): AgentStackToken[] {
  if (agentIds.length === 0) return [];
  if (agentIds.length === 1) {
    return [{ type: 'face', agentId: agentIds[0] }];
  }

  const tokens: AgentStackToken[] = [
    { type: 'face', agentId: agentIds[0] },
    { type: 'face', agentId: agentIds[1] },
  ];

  if (agentIds.length > 2) {
    tokens.push({ type: 'overflow', label: `+${agentIds.length - 2}` });
  }

  return tokens;
}

function run(): void {
  const one = buildStackTokens(['ai:claude']);
  assert(one.length === 1, 'Expected one token for a single agent');
  assert(one[0].type === 'face', 'Expected single agent to render one face');

  const two = buildStackTokens(['ai:claude', 'ai:gemini']);
  assert(two.length === 2, 'Expected two tokens for two agents');
  assert(two.every((token) => token.type === 'face'), 'Expected two agents to render only faces');

  const three = buildStackTokens(['ai:claude', 'ai:gemini', 'ai:chatgpt']);
  assert(three.length === 3, 'Expected three tokens for three agents');
  assert(three[0].type === 'face' && three[1].type === 'face', 'Expected first two tokens to be faces');
  assert(three[2].type === 'overflow' && three[2].label === '+1', 'Expected three agents to render +1 overflow chip');

  const five = buildStackTokens(['a', 'b', 'c', 'd', 'e']);
  assert(five.length === 3, 'Expected five agents to collapse to two faces plus overflow');
  assert(five[2].type === 'overflow' && five[2].label === '+3', 'Expected five agents to render +3 overflow chip');

  console.log('✓ share pill agent stack tokens');
}

run();
