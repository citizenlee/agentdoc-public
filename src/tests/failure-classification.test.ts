import assert from 'node:assert/strict';
import { classifyFailureClassification } from '../../scripts/lib/failure-classification';

function run(): void {
  assert.equal(
    classifyFailureClassification({ failureSurface: 'canonical_markdown' }),
    'WRITE_PATH',
  );
  assert.equal(
    classifyFailureClassification({ failureSurface: 'share_page' }),
    'WRITE_PATH',
  );
  assert.equal(
    classifyFailureClassification({ failureSurface: 'fragment_rendered' }),
    'PROJECTION_FRAGMENT',
  );
  assert.equal(
    classifyFailureClassification({
      failureSurface: 'live_viewer',
      collab: { status: 'pending' },
    }),
    'COLLAB_PRESENCE',
  );
  assert.equal(
    classifyFailureClassification({ failureSurface: 'live_viewer' }),
    'OBSERVATION_HARNESS',
  );
  assert.equal(
    classifyFailureClassification({
      failureSurface: 'harness_output_only',
      failureReason: 'Yjs prosemirror fragment missing marker',
    }),
    'PROJECTION_FRAGMENT',
  );
  assert.equal(
    classifyFailureClassification({
      failureSurface: 'harness_output_only',
      failureReason: 'State section diverged from canonical section',
    }),
    'WRITE_PATH',
  );
  assert.equal(
    classifyFailureClassification({
      failureSurface: 'harness_output_only',
      failureReason: 'Exact convergence never reached all four sources before timeout',
    }),
    'OBSERVATION_HARNESS',
  );
  assert.equal(
    classifyFailureClassification({
      failureSurface: 'harness_output_only',
      failureReason: 'HTTP 502 timeout while loading viewer',
    }),
    'ENV_DEPLOY',
  );
  assert.equal(
    classifyFailureClassification({
      failureSurface: null,
      failureReason: 'Viewer is not built. Run `npm run build` before local harness execution.',
    }),
    'ENV_DEPLOY',
  );
  assert.equal(
    classifyFailureClassification({
      failureSurface: null,
      collab: { status: 'pending', reason: 'sync_timeout' },
    }),
    'COLLAB_PRESENCE',
  );
  assert.equal(
    classifyFailureClassification({ failureSurface: null }),
    'UNKNOWN',
  );

  console.log('✓ failure classification');
}

run();
