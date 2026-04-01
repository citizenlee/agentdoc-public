export interface CollapsedSelectionBarVisibilityContext {
  hasCachedRange: boolean;
  hasLastRange: boolean;
  preserveCollapsedVisibility: boolean;
}

export function shouldKeepCollapsedSelectionBarVisible(
  context: CollapsedSelectionBarVisibilityContext
): boolean {
  return context.hasCachedRange && context.hasLastRange && context.preserveCollapsedVisibility;
}
