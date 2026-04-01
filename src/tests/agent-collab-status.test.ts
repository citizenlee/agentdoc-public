import assert from 'node:assert/strict';
import {
  deriveCollabApplied,
  deriveCursorApplied,
  derivePresenceApplied,
} from '../../server/agent-collab-status.js';

function run(): void {
  assert.equal(
    deriveCollabApplied({ fragmentConfirmed: true, markdownConfirmed: false, confirmed: false }),
    false,
  );
  assert.equal(
    deriveCollabApplied({ fragmentConfirmed: false, markdownConfirmed: true, confirmed: true }),
    true,
  );
  assert.equal(
    deriveCollabApplied({ confirmed: true }),
    true,
  );
  assert.equal(
    deriveCollabApplied({}),
    false,
  );
  assert.equal(
    derivePresenceApplied({ fragmentConfirmed: true, presenceApplied: false }),
    false,
  );
  assert.equal(
    derivePresenceApplied({ presenceApplied: true }),
    true,
  );
  assert.equal(
    deriveCursorApplied({ fragmentConfirmed: true, cursorApplied: false }),
    false,
  );
  assert.equal(
    deriveCursorApplied({ cursorApplied: true }),
    true,
  );

  console.log('✓ agent collab response flags derive from the correct signals');
}

run();
