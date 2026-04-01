import { executeBridgeCall } from '../bridge/bridge-executor';

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

function assertEqual<T>(actual: T, expected: T, message: string): void {
  if (actual !== expected) {
    throw new Error(`${message} (expected=${String(expected)} actual=${String(actual)})`);
  }
}

async function run(): Promise<void> {
  const originalWindow = (globalThis as { window?: unknown }).window;

  try {
    let commentSelectorPayload: unknown = null;
    let commentMeta: unknown = null;
    let suggestReplaceRange: unknown = null;
    let suggestReplaceMeta: unknown = null;
    let suggestInsertMeta: unknown = null;
    let suggestDeleteRange: unknown = null;
    let suggestDeleteMeta: unknown = null;
    let rewriteContent: unknown = null;
    let rewriteBy: unknown = null;
    let rewriteOptions: unknown = null;

    (globalThis as { window: unknown }).window = {
      agentdoc: {
        documentPath: '/tmp/doc.md',
        snapshotContent: 'A B C',
        marksFixture: [{ id: 'm1' }],
        getFullState() {
          return { documentPath: this.documentPath };
        },
        getMarkdownSnapshot() {
          return { content: this.snapshotContent };
        },
        looksLikeMarkdown(_content: string) {
          return false;
        },
        getAllMarks() {
          return this.marksFixture;
        },
        markComment: (quote: string, by: string, text: string, meta?: unknown) => {
          commentMeta = meta;
          return { id: 'c1', quote, by, text };
        },
        markCommentSelector: (selector: unknown, by: string, text: string, _meta?: unknown) => {
          commentSelectorPayload = { selector, by, text };
          return { id: 'c-selector' };
        },
        markSuggestReplace: (
          _quote: string,
          _by: string,
          _content: string,
          range?: unknown,
          meta?: unknown
        ) => {
          suggestReplaceRange = range;
          suggestReplaceMeta = meta;
          return { id: 's-replace' };
        },
        markSuggestInsert: (
          _quote: string,
          _by: string,
          _content: string,
          _range?: unknown,
          meta?: unknown
        ) => {
          suggestInsertMeta = meta;
          return { id: 's-insert' };
        },
        markSuggestDelete: (_quote: string, _by: string, range?: unknown, meta?: unknown) => {
          suggestDeleteRange = range;
          suggestDeleteMeta = meta;
          return { id: 's-delete' };
        },
        markAccept: () => true,
        markReject: () => true,
        markReply: () => ({ id: 'r1' }),
        markResolve: () => true,
        rewriteDocument: (_content: string, _by: string, options?: unknown) => {
          rewriteContent = _content;
          rewriteBy = _by;
          rewriteOptions = options;
          return { success: true, mode: 'highlights', marks: [] };
        },
      },
    };

    const unknownRoute = await executeBridgeCall('POST', '/unknown', {});
    assert((unknownRoute as { success?: boolean }).success === false, 'Unknown route should fail');

    const missingField = await executeBridgeCall('POST', '/marks/comment', { by: 'ai:test' });
    assert((missingField as { success?: boolean }).success === false, 'Missing required field should fail');

    const state = await executeBridgeCall('GET', '/state', {});
    assertEqual(
      (state as { documentPath?: string }).documentPath,
      '/tmp/doc.md',
      'State route should return native state payload'
    );

    const marks = await executeBridgeCall('GET', '/marks', {});
    assertEqual((marks as { success?: boolean }).success, true, 'Marks route should succeed');
    assertEqual(
      Array.isArray((marks as { marks?: unknown[] }).marks),
      true,
      'Marks route should return marks array'
    );

    const comment = await executeBridgeCall('POST', '/marks/comment', {
      quote: 'hello',
      by: 'ai:test',
      text: 'hi',
      runId: 'run-quote',
    });
    assertEqual((comment as { success?: boolean }).success, true, 'Comment route should succeed');
    assertEqual(
      (commentMeta as { runId?: string } | null)?.runId,
      'run-quote',
      'Comment route should forward orchestration metadata'
    );

    const selectorComment = await executeBridgeCall('POST', '/marks/comment', {
      selector: { quote: 'hello' },
      by: 'ai:test',
      text: 'hi',
    });
    assertEqual(
      (selectorComment as { success?: boolean }).success,
      true,
      'Selector comment should succeed without quote'
    );
    assertEqual(
      Boolean((commentSelectorPayload as { selector?: unknown } | null)?.selector),
      true,
      'Selector comment should call markCommentSelector when available'
    );

    const missingCommentAnchor = await executeBridgeCall('POST', '/marks/comment', {
      by: 'ai:test',
      text: 'hi',
    });
    assertEqual(
      (missingCommentAnchor as { success?: boolean }).success,
      false,
      'Comment should fail when both quote and selector are missing'
    );

    const replace = await executeBridgeCall('POST', '/marks/suggest-replace', {
      quote: 'hello',
      by: 'ai:test',
      content: 'hello world',
      range: { from: 4, to: 9 },
      runId: 'run-replace',
    });
    assertEqual((replace as { success?: boolean }).success, true, 'Replace suggestion route should succeed');
    assertEqual(
      (suggestReplaceRange as { from?: number } | null)?.from,
      4,
      'Replace suggestion should forward range'
    );
    assertEqual(
      (suggestReplaceMeta as { runId?: string } | null)?.runId,
      'run-replace',
      'Replace suggestion should forward orchestration metadata'
    );

    const insert = await executeBridgeCall('POST', '/marks/suggest-insert', {
      quote: 'hello',
      by: 'ai:test',
      content: ' world',
      runId: 'run-insert',
    });
    assertEqual((insert as { success?: boolean }).success, true, 'Insert suggestion route should succeed');
    assert(
      Boolean((suggestInsertMeta as { allowShareContentMutation?: boolean } | null)?.allowShareContentMutation),
      'Insert suggestion should pass share-mutation allowance metadata'
    );
    assertEqual(
      (suggestInsertMeta as { runId?: string } | null)?.runId,
      'run-insert',
      'Insert suggestion should preserve orchestration metadata'
    );

    const deletion = await executeBridgeCall('POST', '/marks/suggest-delete', {
      quote: 'hello',
      by: 'ai:test',
      range: { from: 1, to: 3 },
      focusAreaId: 'focus-delete',
    });
    assertEqual((deletion as { success?: boolean }).success, true, 'Delete suggestion route should succeed');
    assertEqual(
      (suggestDeleteRange as { to?: number } | null)?.to,
      3,
      'Delete suggestion should forward range'
    );
    assertEqual(
      (suggestDeleteMeta as { focusAreaId?: string } | null)?.focusAreaId,
      'focus-delete',
      'Delete suggestion should forward orchestration metadata'
    );

    const rewrite = await executeBridgeCall('POST', '/rewrite', {
      content: '# New content',
      by: 'ai:test',
    });
    assertEqual((rewrite as { success?: boolean }).success, true, 'Rewrite route should succeed');
    assert(
      Boolean((rewriteOptions as { allowShareContentMutation?: boolean } | null)?.allowShareContentMutation),
      'Rewrite should pass share-mutation allowance options'
    );

    const rewriteChanges = await executeBridgeCall('POST', '/rewrite', {
      changes: [{ find: 'A', replace: 'Z' }],
    });
    assertEqual(
      (rewriteChanges as { success?: boolean }).success,
      true,
      'Rewrite should support changes mode without by'
    );
    assertEqual(rewriteBy as string, 'ai:unknown', 'Rewrite should default missing by to ai:unknown');
    assertEqual(rewriteContent as string, 'Z B C', 'Rewrite should apply changes to markdown snapshot content');

    const rewriteInvalidChanges = await executeBridgeCall('POST', '/rewrite', {
      changes: [{ find: '', replace: 'x' }],
    });
    assertEqual(
      (rewriteInvalidChanges as { code?: string }).code as string,
      'invalid_changes_payload',
      'Rewrite should validate changes payload'
    );

    console.log('bridge-executor.test.ts passed');
  } finally {
    if (originalWindow === undefined) {
      delete (globalThis as { window?: unknown }).window;
    } else {
      (globalThis as { window?: unknown }).window = originalWindow;
    }
  }
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
