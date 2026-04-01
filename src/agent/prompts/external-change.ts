/**
 * External Change Prompt
 *
 * Used when the file is modified externally while the user has unsaved edits.
 * The agent analyzes both versions and either applies changes as suggestions
 * or signals that a dialog should be shown.
 */

export function getExternalChangePrompt(
  editorContent: string,
  diskContent: string
): string {
  return `The file you're editing was modified externally while the user had unsaved changes.

CURRENT EDITOR CONTENT (the user's version with their unsaved edits):
---
${editorContent}
---

NEW DISK CONTENT (the external version):
---
${diskContent}
---

Your job: analyze the differences and help the user incorporate the external changes.

If the changes are manageable (a few edits, additions, or deletions):
- Use create_suggestion to apply each external change as a tracked suggestion
- The user will see these as suggestions they can accept or reject individually
- Use type "insert" for new content, "delete" for removed content, "replace" for changed content
- The "selector" parameter should match text in the CURRENT EDITOR CONTENT (use exact quoted text)

If the changes are too extensive (the file was completely rewritten, or the changes are so numerous that individual suggestions would be overwhelming):
- Call show_conflict_dialog with a clear, brief message explaining what happened
- Example: "This file was completely rewritten externally. The new version is substantially different from your current edits."

Be concise. Don't apply more than ~20 suggestions — if you'd need more, use the dialog instead.`;
}
