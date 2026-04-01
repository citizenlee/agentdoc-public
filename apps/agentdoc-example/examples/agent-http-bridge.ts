import {
  createAgentBridgeClient,
  type AgentProvider,
  type AgentProviderRequest,
  type AgentProviderResponse,
} from '@agentdoc/agent-bridge';

interface CreateDocumentResponse {
  slug: string;
  accessToken: string;
  shareUrl?: string;
  agent?: {
    stateApi?: string;
  };
}

class DemoAgentProvider implements AgentProvider {
  async complete(request: AgentProviderRequest): Promise<AgentProviderResponse> {
    const latestUserMessage = [...request.messages].reverse().find((message) => message.role === 'user');
    const text = latestUserMessage?.content?.trim() || 'Review the introduction and tighten the opening claim.';
    return {
      message: {
        role: 'assistant',
        content: `Suggested focus: ${text}`,
        name: 'agentdoc-example-agent',
      },
      text: `Suggested focus: ${text}`,
      metadata: {
        provider: 'demo',
      },
    };
  }
}

async function createDocument(baseUrl: string, title: string, markdown: string): Promise<CreateDocumentResponse> {
  const response = await fetch(`${baseUrl}/documents`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      title,
      markdown,
    }),
  });
  if (!response.ok) {
    throw new Error(`Document creation failed with ${response.status}`);
  }
  return response.json() as Promise<CreateDocumentResponse>;
}

async function run(): Promise<void> {
  const baseUrl = (process.env.AGENTDOC_BASE_URL || 'http://127.0.0.1:4000').replace(/\/+$/, '');
  const title = process.env.AGENTDOC_DEMO_TITLE || 'Agentdoc SDK Example';
  const markdown = process.env.AGENTDOC_DEMO_MARKDOWN || '# Hello\n\nThis draft needs a stronger opening.';
  const provider = new DemoAgentProvider();

  const created = await createDocument(baseUrl, title, markdown);
  if (!created.slug || !created.accessToken) {
    throw new Error('Create response did not include slug/accessToken');
  }

  const bridge = createAgentBridgeClient({
    baseUrl,
    auth: {
      shareToken: created.accessToken,
    },
  });

  await bridge.setPresence(created.slug, {
    agentId: 'agent:agentdoc-example',
    status: 'reviewing',
    summary: 'Reading the current draft',
    name: 'Agentdoc Example Agent',
    color: '#266854',
  });

  const state = await bridge.getState<{ markdown?: string }>(created.slug);
  const review = await provider.complete({
    messages: [
      {
        role: 'system',
        content: 'You are a lightweight review agent operating through the Agentdoc SDK bridge.',
      },
      {
        role: 'user',
        content: state.markdown || markdown,
      },
    ],
    metadata: {
      slug: created.slug,
    },
  });

  await bridge.addComment(created.slug, {
    by: 'ai:agentdoc-example',
    quote: 'stronger opening',
    text: review.text || review.message.content,
  });

  console.log(JSON.stringify({
    success: true,
    slug: created.slug,
    shareUrl: created.shareUrl ?? `${baseUrl}/d/${created.slug}`,
    stateApi: created.agent?.stateApi ?? `${baseUrl}/documents/${created.slug}/state`,
    commentPosted: true,
  }, null, 2));
}

run().catch((error) => {
  console.error('[agentdoc-example] agent bridge demo failed');
  console.error(error);
  process.exit(1);
});
