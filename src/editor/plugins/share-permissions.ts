type ShareRuntimeCapabilities = {
  canComment: boolean;
  canEdit: boolean;
};

let runtimeCapabilities: ShareRuntimeCapabilities = {
  canComment: true,
  canEdit: true,
};

export function setShareRuntimeCapabilities(capabilities: Partial<ShareRuntimeCapabilities>): void {
  runtimeCapabilities = {
    canComment: capabilities.canComment ?? runtimeCapabilities.canComment,
    canEdit: capabilities.canEdit ?? runtimeCapabilities.canEdit,
  };
}

export function resetShareRuntimeCapabilities(): void {
  runtimeCapabilities = {
    canComment: true,
    canEdit: true,
  };
}

export function canCommentInRuntime(): boolean {
  return runtimeCapabilities.canComment;
}

export function canEditInRuntime(): boolean {
  return runtimeCapabilities.canEdit;
}
