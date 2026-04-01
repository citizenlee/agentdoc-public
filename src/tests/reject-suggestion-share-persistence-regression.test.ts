import { readFileSync } from 'node:fs';
import path from 'node:path';

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

function run(): void {
  const editorSource = readFileSync(path.resolve(process.cwd(), 'src/editor/index.ts'), 'utf8');
  const engineSource = readFileSync(path.resolve(process.cwd(), 'server/document-engine.ts'), 'utf8');

  const markRejectStart = editorSource.indexOf('markReject(markId: string): boolean {');
  assert(markRejectStart !== -1, 'Expected editor markReject implementation');

  const markRejectEnd = editorSource.indexOf('\n  /**\n   * Accept all pending suggestions', markRejectStart);
  assert(markRejectEnd !== -1, 'Expected to isolate markReject body');

  const markRejectBlock = editorSource.slice(markRejectStart, markRejectEnd);

  assert(markRejectBlock.includes('success = rejectMark(view, markId);'), 'Expected markReject to call rejectMark in the editor plugin');
  assert(markRejectBlock.includes('if (success && this.isShareMode) {'), 'Regression guard: rejecting a suggestion in share mode must persist updated marks');
  assert(
    markRejectBlock.includes('const metadata = getMarkMetadataWithQuotes(view.state);')
      && markRejectBlock.includes('this.lastReceivedServerMarks = { ...metadata };')
      && markRejectBlock.includes('this.initialMarksSynced = true;')
      && markRejectBlock.includes('const actor = getCurrentActor();')
      && markRejectBlock.includes('void shareClient.rejectSuggestion(markId, actor).then(async (result) => {')
      && markRejectBlock.includes('this.lastReceivedServerMarks = { ...serverMarks };')
      && markRejectBlock.includes('this.initialMarksSynced = true;'),
    'Expected markReject to snapshot the local cleared metadata and then refresh it from the explicit share reject mutation',
  );
  assert(
    markRejectBlock.includes('const mergedMetadata = mergePendingServerMarks(getMarkMetadataWithQuotes(innerView.state), serverMarks);')
      && markRejectBlock.includes('setMarkMetadata(innerView, mergedMetadata);'),
    'Expected markReject to evict stale pending suggestion metadata after the server reject mutation returns',
  );
  assert(
    markRejectBlock.includes("console.error('[markReject] Failed to persist suggestion rejection via share mutation:', error);"),
    'Expected markReject to log share mutation persistence failures for reject actions',
  );
  assert(!markRejectBlock.includes('shareClient.pushUpdate('), 'markReject must not require a content write to persist suggestion rejection');
  assert(!markRejectBlock.includes('shareClient.pushMarks('), 'markReject should not depend on a broad marks PUT when a dedicated reject mutation exists');
  assert(
    engineSource.includes("if (status === 'rejected') {")
      && engineSource.includes('bumpDocumentAccessEpoch(slug);')
      && engineSource.includes('invalidateCollabDocument(slug);')
      && engineSource.includes('void applyCanonicalDocumentToCollab(slug, {')
      && engineSource.includes('markdown: collabMarkdown,')
      && engineSource.includes("console.error('[document-engine] Failed to sync suggestion status to collab projection; invalidating collab state'"),
    'Expected server-side suggestion status persistence to stale out collab sessions for rejects and reconcile canonical markdown + marks for other finalizations',
  );

  console.log('✓ rejecting a suggestion persists share marks without content writes');
}

try {
  run();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
