import assert from 'node:assert/strict';
import {
  classifyExactFailureSurface,
  classifyFailureSurfaceBySource,
} from '../../scripts/lib/failure-surface';

function run(): void {
  assert.equal(classifyFailureSurfaceBySource('state'), 'canonical_markdown');
  assert.equal(classifyFailureSurfaceBySource('shared-markdown'), 'share_page');
  assert.equal(classifyFailureSurfaceBySource('viewer-text'), 'live_viewer');
  assert.equal(classifyFailureSurfaceBySource('yjs-markdown'), 'fragment_rendered');
  assert.equal(classifyFailureSurfaceBySource('yjs-fragment'), 'fragment_rendered');
  assert.equal(classifyFailureSurfaceBySource('unknown'), 'harness_output_only');
  assert.equal(classifyFailureSurfaceBySource(null), 'harness_output_only');

  assert.equal(classifyExactFailureSurface({ statePlacementError: 'bad' }), 'canonical_markdown');
  assert.equal(classifyExactFailureSurface({ sharedPlacementError: 'bad' }), 'share_page');
  assert.equal(classifyExactFailureSurface({ yjsPlacementError: 'bad' }), 'fragment_rendered');
  assert.equal(classifyExactFailureSurface({ fragmentMissingMarker: true }), 'fragment_rendered');
  assert.equal(classifyExactFailureSurface({ viewerMissingMarker: true }), 'live_viewer');
  assert.equal(
    classifyExactFailureSurface({ exactSectionError: 'Viewer section diverged from canonical section' }),
    'live_viewer',
  );
  assert.equal(classifyExactFailureSurface({ sectionMissingError: 'missing' }), 'harness_output_only');

  console.log('✓ failure surface classifier');
}

run();
