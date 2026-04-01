import assert from 'node:assert/strict';
import { recoverShareMarksAfterMutationFailure } from '../editor/share-mark-mutation.js';

async function run(): Promise<void> {
  let bannerMessage = '';
  let appliedMarks: Record<string, unknown> | null = null;
  let fetchCount = 0;

  const result = await recoverShareMarksAfterMutationFailure({
    failure: {
      error: {
        status: 409,
        code: 'ANCHOR_NOT_FOUND',
        message: 'Suggestion anchor quote not found in document',
      },
    },
    fallbackMessage: 'Unable to accept suggestion.',
    fetchOpenContext: async () => {
      fetchCount += 1;
      return {
        success: true,
        collabAvailable: false,
        snapshotUrl: null,
        doc: {
          slug: 'test-doc',
          title: 'Test',
          markdown: 'Hello world',
          marks: {
            'server-mark': {
              kind: 'replace',
              by: 'ai:test',
              quote: 'Hello',
              content: 'Hi',
              status: 'pending',
            },
          },
        },
        capabilities: { canRead: true, canComment: true, canEdit: true },
        links: { webUrl: 'https://example.com', snapshotUrl: null },
      };
    },
    showErrorBanner: (message) => {
      bannerMessage = message;
    },
    applyServerMarks: (marks) => {
      appliedMarks = marks;
    },
  });

  assert.equal(result.refreshed, true, 'Expected failure recovery to refetch authoritative marks');
  assert.equal(fetchCount, 1, 'Expected one open-context refresh after mutation failure');
  assert.equal(bannerMessage, 'Suggestion anchor quote not found in document', 'Expected server error to surface in the banner');
  assert.deepEqual(
    appliedMarks,
    {
      'server-mark': {
        kind: 'replace',
        by: 'ai:test',
        quote: 'Hello',
        content: 'Hi',
        status: 'pending',
      },
    },
    'Expected failure recovery to reapply authoritative server marks',
  );

  console.log('share-mark-mutation-failure-recovery.test.ts passed');
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
