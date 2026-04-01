export function shouldPreserveMissingLocalMark(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const kind = (value as { kind?: unknown }).kind;
  if (kind === 'authored') return false;
  // Suggestions should not be force-preserved locally when missing from server marks;
  // accept/reject removes them and stale preservation causes reappearance loops.
  if (kind === 'insert' || kind === 'delete' || kind === 'replace') return false;
  const status = (value as { status?: unknown }).status;
  if (status === 'accepted' || status === 'rejected') return false;
  return true;
}
