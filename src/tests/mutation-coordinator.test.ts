import { adaptMutationResponse } from '../../server/mutation-coordinator.js';

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

function test(name: string, fn: () => void): void {
  try {
    fn();
    console.log('  \u2713', name);
  } catch (error) {
    console.error('  \u2717', name);
    console.error(error instanceof Error ? error.stack : String(error));
    process.exitCode = 1;
  }
}

const previousFlag = process.env.PROOF_MUTATION_COORDINATOR_ENABLED;

try {
  test('returns legacy shape when coordinator flag is disabled', () => {
    delete process.env.PROOF_MUTATION_COORDINATOR_ENABLED;
    const result = adaptMutationResponse(409, { success: false, code: 'STALE_BASE', error: 'stale' }, { route: 'POST /edit', slug: 'abc' });
    assert(result.status === 409, 'Expected status to be preserved');
    assert(result.body.code === 'STALE_BASE', 'Expected legacy payload when disabled');
    assert(result.body.success === false, 'Expected legacy success=false when disabled');
  });

  test('wraps success payload when coordinator flag is enabled', () => {
    process.env.PROOF_MUTATION_COORDINATOR_ENABLED = '1';
    const result = adaptMutationResponse(200, { success: true, updatedAt: '2026-02-23T00:00:00.000Z' }, { route: 'POST /edit', slug: 'abc' });
    assert(result.status === 200, 'Expected status to be preserved');
    assert(result.body.success === true, 'Expected wrapped success');
    assert(result.body.route === 'POST /edit', 'Expected route context');
    const data = result.body.data as Record<string, unknown> | undefined;
    assert(data?.updatedAt === '2026-02-23T00:00:00.000Z', 'Expected original payload in data envelope');
  });

  test('normalizes MISSING_BASE without strict enforcement change', () => {
    process.env.PROOF_MUTATION_COORDINATOR_ENABLED = 'true';
    const result = adaptMutationResponse(
      409,
      { success: false, error: 'baseUpdatedAt is required for edits' },
      { route: 'POST /edit', slug: 'abc', retryWithState: '/api/agent/abc/state' },
    );
    assert(result.status === 409, 'Expected status 409');
    assert(result.body.success === false, 'Expected failure envelope');
    assert(result.body.code === 'MISSING_BASE', 'Expected inferred MISSING_BASE code');
    assert(result.body.retryWithState === '/api/agent/abc/state', 'Expected retryWithState passthrough');
  });

  test('preserves explicit known error code', () => {
    process.env.PROOF_MUTATION_COORDINATOR_ENABLED = 'yes';
    const result = adaptMutationResponse(
      422,
      { success: false, code: 'ANCHOR_NOT_FOUND', error: 'Suggestion anchor quote not found in document' },
      { route: 'POST /ops', slug: 'abc' },
    );
    assert(result.body.code === 'ANCHOR_NOT_FOUND', 'Expected explicit code to be preserved');
    assert(result.body.message === 'Suggestion anchor quote not found in document', 'Expected message normalization from error');
  });

  test('classifies generic 5xx failures as INTERNAL_ERROR', () => {
    process.env.PROOF_MUTATION_COORDINATOR_ENABLED = 'on';
    const result = adaptMutationResponse(500, { success: false, error: 'boom' }, { route: 'POST /rewrite', slug: 'abc' });
    assert(result.body.code === 'INTERNAL_ERROR', 'Expected INTERNAL_ERROR classification');
  });
} finally {
  if (previousFlag === undefined) delete process.env.PROOF_MUTATION_COORDINATOR_ENABLED;
  else process.env.PROOF_MUTATION_COORDINATOR_ENABLED = previousFlag;
}

if (process.exitCode) {
  process.exit(process.exitCode);
}
