import { unlinkSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import express from 'express';
import type { AddressInfo } from 'node:net';

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

type ShareCreateResponse = {
  slug: string;
  ownerSecret: string;
};

type AgentEvent = {
  id: number;
  type: string;
  data: Record<string, unknown>;
  actor: string;
};

type AgentEventsResponse = {
  success: boolean;
  events: AgentEvent[];
};

const CLIENT_HEADERS = {
  'X-Agentdoc-Client-Version': '0.31.2',
  'X-Agentdoc-Client-Build': 'tests',
  'X-Agentdoc-Client-Protocol': '3',
};

async function mustJson<T>(response: Response): Promise<T> {
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${text.slice(0, 240)}`);
  }
  return JSON.parse(text) as T;
}

async function putMarks(
  baseUrl: string,
  slug: string,
  ownerSecret: string,
  marks: Record<string, unknown>,
  actor: string,
): Promise<void> {
  const response = await fetch(`${baseUrl}/api/documents/${slug}`, {
    method: 'PUT',
    headers: {
      ...CLIENT_HEADERS,
      'Content-Type': 'application/json',
      'x-share-token': ownerSecret,
    },
    body: JSON.stringify({
      marks,
      actor,
    }),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`PUT /documents failed HTTP ${response.status}: ${text.slice(0, 240)}`);
  }
}

async function run(): Promise<void> {
  const dbName = `agentdoc-rest-put-comment-events-${Date.now()}-${randomUUID()}.db`;
  const dbPath = path.join(os.tmpdir(), dbName);
  process.env.DATABASE_PATH = dbPath;

  const [{ apiRoutes }, { agentRoutes }] = await Promise.all([
    import('../../server/routes.ts'),
    import('../../server/agent-routes.ts'),
  ]);

  const app = express();
  app.use(express.json({ limit: '2mb' }));
  app.use('/api', apiRoutes);
  app.use('/api/agent', agentRoutes);

  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    const createRes = await fetch(`${baseUrl}/api/documents`, {
      method: 'POST',
      headers: {
        ...CLIENT_HEADERS,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        markdown: '# Title\n\nhello world',
        marks: {},
        title: 'REST comment events',
      }),
    });
    const created = await mustJson<ShareCreateResponse>(createRes);
    assert(typeof created.slug === 'string' && created.slug.length > 0, 'Expected create slug');
    assert(typeof created.ownerSecret === 'string' && created.ownerSecret.length > 0, 'Expected owner secret');

    const markId = 'm-comment-1';
    const commentCreatedAt = '2026-03-05T00:00:00.000Z';
    const replyAt = '2026-03-05T00:01:00.000Z';
    const commentBy = 'human:Dan';
    const replyBy = 'human:Brandon';

    const marksWithComment: Record<string, unknown> = {
      [markId]: {
        kind: 'comment',
        by: commentBy,
        createdAt: commentCreatedAt,
        quote: 'hello world',
        text: 'This needs work',
        threadId: markId,
        thread: [],
        replies: [],
        resolved: false,
      },
    };
    await putMarks(baseUrl, created.slug, created.ownerSecret, marksWithComment, 'human:SystemAdd');

    const marksWithReply: Record<string, unknown> = {
      [markId]: {
        ...(marksWithComment[markId] as Record<string, unknown>),
        thread: [{ by: replyBy, text: 'Replying here', at: replyAt }],
        replies: [{ by: replyBy, text: 'Replying here', at: replyAt }],
      },
    };
    await putMarks(baseUrl, created.slug, created.ownerSecret, marksWithReply, 'human:SystemReply');

    const marksResolved: Record<string, unknown> = {
      [markId]: {
        ...(marksWithReply[markId] as Record<string, unknown>),
        resolved: true,
      },
    };
    await putMarks(baseUrl, created.slug, created.ownerSecret, marksResolved, 'human:SystemResolve');

    const eventsRes = await fetch(`${baseUrl}/api/agent/${created.slug}/events/pending?after=0&limit=500`, {
      headers: {
        ...CLIENT_HEADERS,
        'x-share-token': created.ownerSecret,
      },
    });
    const eventsPayload = await mustJson<AgentEventsResponse>(eventsRes);
    assert(eventsPayload.success === true, 'Expected events success');

    const commentEvents = eventsPayload.events.filter((event) => event.type.startsWith('comment.'));
    assert(commentEvents.length === 3, `Expected 3 comment events, got ${commentEvents.length}`);

    const types = commentEvents.map((event) => event.type).join(',');
    assert(types === 'comment.added,comment.replied,comment.resolved', `Unexpected comment event order/types: ${types}`);

    const added = commentEvents[0]!;
    assert(added.actor === commentBy, `Expected comment.added actor=${commentBy}, got ${added.actor}`);
    assert(added.data.markId === markId, 'Expected comment.added markId');
    assert(added.data.by === commentBy, 'Expected comment.added data.by');
    assert(added.data.text === 'This needs work', 'Expected comment.added data.text');

    const replied = commentEvents[1]!;
    assert(replied.actor === replyBy, `Expected comment.replied actor=${replyBy}, got ${replied.actor}`);
    assert(replied.data.markId === markId, 'Expected comment.replied markId');
    assert(replied.data.by === replyBy, 'Expected comment.replied data.by');
    assert(replied.data.text === 'Replying here', 'Expected comment.replied data.text');

    const resolved = commentEvents[2]!;
    assert(resolved.actor === 'human:SystemResolve', `Expected comment.resolved actor=human:SystemResolve, got ${resolved.actor}`);
    assert(resolved.data.markId === markId, 'Expected comment.resolved markId');
    assert(resolved.data.by === 'human:SystemResolve', 'Expected comment.resolved data.by');

    console.log('✓ REST PUT marks emits comment.added/comment.replied/comment.resolved in document events');
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    for (const suffix of ['', '-wal', '-shm']) {
      try {
        unlinkSync(`${dbPath}${suffix}`);
      } catch {
        // ignore cleanup errors
      }
    }
  }
}

run().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
