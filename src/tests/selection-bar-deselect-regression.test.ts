import { shouldKeepCollapsedSelectionBarVisible } from '../editor/plugins/selection-bar-visibility.js';

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

function run(): void {
  assert(
    shouldKeepCollapsedSelectionBarVisible({
      hasCachedRange: true,
      hasLastRange: true,
      preserveCollapsedVisibility: true
    }) === true,
    'Selection bar should remain visible only when cached range and last range both exist during interaction grace'
  );

  assert(
    shouldKeepCollapsedSelectionBarVisible({
      hasCachedRange: true,
      hasLastRange: true,
      preserveCollapsedVisibility: false
    }) === false,
    'Selection bar should hide once interaction grace expires'
  );

  assert(
    shouldKeepCollapsedSelectionBarVisible({
      hasCachedRange: true,
      hasLastRange: false,
      preserveCollapsedVisibility: true
    }) === false,
    'Selection bar should hide when there is no last range anchor'
  );

  assert(
    shouldKeepCollapsedSelectionBarVisible({
      hasCachedRange: false,
      hasLastRange: true,
      preserveCollapsedVisibility: true
    }) === false,
    'Selection bar should hide when there is no cached range to apply actions against'
  );
}

try {
  run();
  console.log('✅ selection bar deselect regression guard passed');
} catch (error) {
  console.error('❌ selection bar deselect regression guard failed');
  console.error(`   ${(error as Error).message}`);
  process.exit(1);
}
