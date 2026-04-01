function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

type FetchCall = {
  url: string;
  headers: Record<string, string>;
  body: string;
};

async function run(): Promise<void> {
  const prevWindow = (globalThis as { window?: unknown }).window;
  const prevFetch = globalThis.fetch;

  const calls: FetchCall[] = [];
  const responses: Array<Record<string, unknown>> = [
    { success: true, disconnected: true },
    { success: true, disconnected: true },
    { success: true },
    { success: true },
  ];

  try {
    (globalThis as { window?: unknown }).window = {
      location: {
        origin: 'https://www.agentdoc.com',
        pathname: '/d/test-slug',
        search: '?token=query-token',
      },
      __AGENTDOC_CONFIG__: {},
    };

    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      calls.push({
        url: String(input),
        headers,
        body: typeof init?.body === 'string' ? init.body : '',
      });
      const next = responses.shift() ?? { success: false, disconnected: false };
      return new Response(JSON.stringify(next), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof fetch;

    const mod = await import('../bridge/share-client.ts');
    const client = new mod.ShareClient();

    const ok = await client.disconnectAgentPresence('ai:claude');
    assert(ok === true, 'Expected disconnect call to return true');
    assert(calls.length === 1, `Expected one request, got ${calls.length}`);
    assert(
      calls[0]?.url.endsWith('/api/agent/test-slug/presence/disconnect'),
      `Expected disconnect endpoint URL, got ${String(calls[0]?.url)}`,
    );
    assert(
      calls[0]?.headers?.['x-share-token'] === 'query-token',
      'Expected x-share-token from query token',
    );
    assert(
      calls[0]?.body.includes('"agentId":"ai:claude"'),
      `Expected request body to include agentId, got ${String(calls[0]?.body)}`,
    );

    const okWithOverride = await client.disconnectAgentPresence('ai:codex', { token: 'override-token' });
    assert(okWithOverride === true, 'Expected disconnect call with explicit token override to return true');
    assert(calls.length === 2, `Expected two requests, got ${calls.length}`);
    assert(
      calls[1]?.headers?.['x-share-token'] === 'override-token',
      'Expected explicit token to override query token header',
    );
    assert(
      calls[1]?.body.includes('"agentId":"ai:codex"'),
      `Expected request body to include overridden agentId, got ${String(calls[1]?.body)}`,
    );

    const invalid = await client.disconnectAgentPresence('   ');
    assert(invalid === false, 'Expected blank agentId to return false without request');
    assert(calls.length === 2, `Expected no extra request for blank agentId, got ${calls.length}`);

    const titleUpdated = await client.updateTitle('New Header Title');
    assert(titleUpdated === true, 'Expected title update to return true');
    assert(calls.length === 3, `Expected third request for title update, got ${calls.length}`);
    assert(
      calls[2]?.url.endsWith('/api/documents/test-slug/title'),
      `Expected title update endpoint URL, got ${String(calls[2]?.url)}`,
    );
    assert(
      calls[2]?.headers?.['x-share-token'] === 'query-token',
      'Expected title update to use query token auth',
    );
    assert(
      calls[2]?.body.includes('"title":"New Header Title"'),
      `Expected title update payload body, got ${String(calls[2]?.body)}`,
    );

    const titleUpdatedWithOverride = await client.updateTitle('Override Token Title', { token: 'override-token' });
    assert(titleUpdatedWithOverride === true, 'Expected title update with override token to return true');
    assert(calls.length === 4, `Expected fourth request for title update override, got ${calls.length}`);
    assert(
      calls[3]?.headers?.['x-share-token'] === 'override-token',
      'Expected explicit token override for title update',
    );
    assert(
      calls[3]?.body.includes('"title":"Override Token Title"'),
      `Expected override title payload body, got ${String(calls[3]?.body)}`,
    );

    const blankTitle = await client.updateTitle('   ');
    assert(blankTitle === false, 'Expected blank title update to return false without request');
    assert(calls.length === 4, `Expected no extra request for blank title, got ${calls.length}`);

    console.log('✓ share client disconnect + title update request contract');
  } finally {
    if (prevWindow === undefined) {
      delete (globalThis as { window?: unknown }).window;
    } else {
      (globalThis as { window?: unknown }).window = prevWindow;
    }
    globalThis.fetch = prevFetch;
  }
}

run().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
