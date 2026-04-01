import { readFileSync } from 'node:fs';
import path from 'node:path';

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

function run(): void {
  const popoverSource = readFileSync(
    path.resolve(process.cwd(), 'src', 'editor', 'plugins', 'mark-popover.ts'),
    'utf8',
  );
  const editorSource = readFileSync(
    path.resolve(process.cwd(), 'src', 'editor', 'index.ts'),
    'utf8',
  );

  assert(
    popoverSource.includes('export type CommentPopoverDraftSnapshot ='),
    'Expected mark-popover to export CommentPopoverDraftSnapshot type',
  );
  assert(
    popoverSource.includes('captureDraftSnapshot(): CommentPopoverDraftSnapshot | null'),
    'Expected mark-popover controller to implement captureDraftSnapshot',
  );
  assert(
    popoverSource.includes('restoreDraftSnapshot(snapshot: CommentPopoverDraftSnapshot): boolean'),
    'Expected mark-popover controller to implement restoreDraftSnapshot',
  );
  assert(
    popoverSource.includes('if (!draftText.trim()) return null;'),
    'Expected draft snapshot capture to skip empty draft text',
  );
  assert(
    popoverSource.includes('export function captureCommentPopoverDraft(view: EditorView): CommentPopoverDraftSnapshot | null'),
    'Expected mark-popover to export captureCommentPopoverDraft helper',
  );
  assert(
    popoverSource.includes('export function restoreCommentPopoverDraft('),
    'Expected mark-popover to export restoreCommentPopoverDraft helper',
  );

  assert(
    editorSource.includes('captureCommentPopoverDraft,')
      && editorSource.includes('restoreCommentPopoverDraft,'),
    'Expected editor to import comment popover draft helpers',
  );
  assert(
    editorSource.includes('private captureCommentPopoverDraftSnapshot(): CommentPopoverDraftSnapshot | null'),
    'Expected editor to capture popover drafts before reconnect',
  );
  assert(
    editorSource.includes('private restoreCommentPopoverDraftWithRetry(snapshot: CommentPopoverDraftSnapshot): void'),
    'Expected editor to retry restoring popover drafts after reconnect',
  );
  assert(
    editorSource.includes('private async refreshCollabSessionAfterDocumentUpdated(): Promise<void>'),
    'Expected dedicated document-updated refresh method with draft preservation',
  );
  assert(
    editorSource.includes("this.scheduleCollabRecovery('document-updated', {")
      && editorSource.includes('const draftSnapshot = preserveCommentDraft')
      && editorSource.includes('this.captureCommentPopoverDraftSnapshot()')
      && editorSource.includes('if (refreshed && draftSnapshot) {')
      && editorSource.includes('this.restoreCommentPopoverDraftWithRetry(draftSnapshot);'),
    'Expected document-updated refreshes to preserve drafts through the queued recovery path',
  );
  assert(
    editorSource.includes('collabClient.onDocumentUpdated(() => {')
      && editorSource.includes("if (this.collabUnsyncedChanges > 0) return;")
      && editorSource.includes("if (this.collabConnectionStatus === 'connected' && this.collabIsSynced) return;")
      && editorSource.includes('void this.refreshCollabSessionAfterDocumentUpdated();'),
    'Expected collab document.updated handler to skip healthy/unsynced sessions before draft-preserving refresh',
  );

  console.log('✓ comment popover draft preservation wiring checks');
}

run();
