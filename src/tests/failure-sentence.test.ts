import assert from 'node:assert/strict';
import { formatFailureSentence } from '../../scripts/lib/failure-sentence';

function run(): void {
  const sentence = formatFailureSentence({
    mutationPath: 'POST /api/agent/:slug/edit',
    viewerCondition: 'live viewers=2',
    documentShape: 'complex doc with repeated headings and long sections',
    failureSurface: 'live_viewer',
  });

  assert.equal(
    sentence,
    'Failure: mutation path POST /api/agent/:slug/edit, viewer condition live viewers=2, document shape complex doc with repeated headings and long sections, observed failing surface live_viewer.',
  );

  console.log('✓ failure sentence formatter');
}

run();
