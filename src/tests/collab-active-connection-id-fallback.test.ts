import { buildActiveCollabConnectionId } from '../../server/collab.ts';

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

function run(): void {
  const explicit = buildActiveCollabConnectionId('socket-123');
  const explicitParts = explicit.split(':');
  assert(
    explicitParts.length >= 2 && explicitParts[explicitParts.length - 1] === 'socket-123',
    `Expected explicit socket id to be preserved, got ${explicit}`,
  );

  const generatedA = buildActiveCollabConnectionId('');
  const generatedB = buildActiveCollabConnectionId('   ');
  const generatedSuffixA = generatedA.split(':').slice(1).join(':');
  const generatedSuffixB = generatedB.split(':').slice(1).join(':');

  assert(
    generatedSuffixA.startsWith('generated-'),
    `Expected generated fallback prefix for empty socket id, got ${generatedA}`,
  );
  assert(
    generatedSuffixB.startsWith('generated-'),
    `Expected generated fallback prefix for whitespace socket id, got ${generatedB}`,
  );
  assert(
    generatedA !== generatedB,
    `Expected distinct connection ids for blank socket ids, got ${generatedA} and ${generatedB}`,
  );

  console.log('✓ active collab connection ids fall back to generated UUIDs when socket id is blank');
}

run();
