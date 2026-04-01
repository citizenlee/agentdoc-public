import type { ShareOpenContext, ShareRequestError } from '../bridge/share-client.js';
import type { StoredMark } from './plugins/marks.js';

function isShareRequestError(value: unknown): value is ShareRequestError {
  return Boolean(
    value
    && typeof value === 'object'
    && 'error' in value
    && value.error
    && typeof (value as { error?: { message?: unknown } }).error?.message === 'string'
  );
}

function isShareOpenContext(value: unknown): value is ShareOpenContext {
  return Boolean(value && typeof value === 'object' && 'doc' in value);
}

export function getShareMarkMutationFailureMessage(failure: unknown, fallbackMessage: string): string {
  if (isShareRequestError(failure)) {
    const message = failure.error.message.trim();
    return message.length > 0 ? message : fallbackMessage;
  }
  if (failure instanceof Error && failure.message.trim().length > 0) {
    return failure.message.trim();
  }
  return fallbackMessage;
}

export async function recoverShareMarksAfterMutationFailure(args: {
  failure: unknown;
  fallbackMessage: string;
  fetchOpenContext: () => Promise<ShareOpenContext | ShareRequestError | null>;
  showErrorBanner: (message: string) => void;
  applyServerMarks: (marks: Record<string, StoredMark>) => void;
}): Promise<{ message: string; refreshed: boolean }> {
  const message = getShareMarkMutationFailureMessage(args.failure, args.fallbackMessage);
  args.showErrorBanner(message);

  try {
    const context = await args.fetchOpenContext();
    if (!isShareOpenContext(context) || isShareRequestError(context)) {
      return { message, refreshed: false };
    }
    const marks = context.doc?.marks;
    if (!marks || typeof marks !== 'object' || Array.isArray(marks)) {
      return { message, refreshed: false };
    }
    args.applyServerMarks(marks as Record<string, StoredMark>);
    return { message, refreshed: true };
  } catch {
    return { message, refreshed: false };
  }
}
