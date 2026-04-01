import { findBridgeRoutePolicy, getBridgeRoutePolicies } from '../../server/bridge-auth-policy';

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

function run(): void {
  const policies = getBridgeRoutePolicies();
  assert(policies.length > 0, 'Expected bridge policy list to be non-empty');

  const statePolicy = findBridgeRoutePolicy('GET', '/state');
  assert(statePolicy?.auth === 'none', 'GET /state should be unauthenticated');

  const commentPolicy = findBridgeRoutePolicy('POST', '/marks/comment');
  assert(commentPolicy?.auth === 'none', 'POST /marks/comment should be unauthenticated');
  assert(
    Array.isArray(commentPolicy?.required)
    && commentPolicy.required.includes('by')
    && commentPolicy.required.includes('text')
    && !commentPolicy.required.includes('quote'),
    'POST /marks/comment should require by/text and allow selector-only payloads'
  );

  const rewritePolicy = findBridgeRoutePolicy('POST', '/rewrite');
  assert(rewritePolicy?.auth === 'none', 'POST /rewrite should be unauthenticated');
  assert(
    rewritePolicy?.required === undefined,
    'POST /rewrite should allow content OR changes and optional by'
  );

  const acceptPolicy = findBridgeRoutePolicy('POST', '/marks/accept');
  assert(acceptPolicy?.auth === 'bridge-token', 'POST /marks/accept should require bridge token');

  const unknownPolicy = findBridgeRoutePolicy('POST', '/not-real');
  assert(unknownPolicy === undefined, 'Unknown routes should not have a bridge policy');

  console.log('bridge-auth-policy.test.ts passed');
}

run();
