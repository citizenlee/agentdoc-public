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
    {
      success: true,
      role: 'viewer',
      accessToken: 'viewer-access-token',
      webShareUrl: 'https://www.agentdoc.com/d/test-slug?token=viewer-access-token',
    },
    {
      success: true,
      role: 'commenter',
      token: 'commenter-legacy-token',
      webShareUrl: 'https://www.agentdoc.com/d/test-slug?token=commenter-legacy-token',
    },
    {
      success: true,
      role: 'editor',
      webShareUrl: 'https://www.agentdoc.com/d/test-slug?token=missing-token',
    },
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
      const next = responses.shift() ?? { success: false };
      return new Response(JSON.stringify(next), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof fetch;

    const mod = await import('../bridge/share-client.ts');
    const client = new mod.ShareClient();

    const viewer = await client.createAccessLink('viewer');
    assert(viewer !== null && !('error' in viewer), 'Expected viewer access-link response');
    assert(viewer.accessToken === 'viewer-access-token', 'Expected accessToken payload to be accepted');
    assert(viewer.token === 'viewer-access-token', 'Expected token alias to normalize from accessToken');
    assert(calls[0]?.headers?.['x-share-token'] === 'query-token', 'Expected query token auth header for access-link call');

    const commenter = await client.createAccessLink('commenter', { token: 'override-token' });
    assert(commenter !== null && !('error' in commenter), 'Expected commenter access-link response');
    assert(commenter.accessToken === 'commenter-legacy-token', 'Expected legacy token payload to be accepted');
    assert(commenter.token === 'commenter-legacy-token', 'Expected normalized token alias for legacy payload');
    assert(calls[1]?.headers?.['x-share-token'] === 'override-token', 'Expected explicit token override header');

    const invalid = await client.createAccessLink('editor');
    assert(invalid === null, 'Expected null for invalid access-link payload without token fields');
    assert(calls.length === 3, `Expected 3 access-link requests, got ${calls.length}`);
    assert(calls[0]?.url.endsWith('/api/documents/test-slug/access-links'), 'Expected access-links endpoint call');
    assert(calls[0]?.body.includes('"role":"viewer"'), 'Expected viewer role in request payload');

    console.log('✓ share client access-link parser supports accessToken/token compatibility');
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
