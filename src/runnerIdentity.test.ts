import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  assignmentMatchesRunner,
  runnerClaimIdentity,
  runnerIdentity,
} from './runnerIdentity.js';
import type { Assignment } from './types.js';

const assignment = (runnerId?: string): Assignment => ({
  id: 'asg_runner',
  objective: 'placed work',
  briefing: 'placed work',
  kind: 'work',
  ...(runnerId ? { runnerId } : {}),
  acceptanceCriteria: [],
  dependsOn: [],
  state: 'queued',
  attempts: [],
  adoption: { state: 'none' },
  createdAtVirtual: '2026-08-29T00:00:00.000Z',
});

test('runner identity uses an explicit stable name and conservatively defaults to hostname', () => {
  assert.equal(runnerIdentity({ WEAVER_RUNNER_ID: 'mac-studio' }, 'ignored-host'), 'mac-studio');
  assert.equal(runnerIdentity({}, 'nialls-macbook'), 'nialls-macbook');
});

test('invalid runner identity and placement-only settings fail clearly', () => {
  assert.throws(() => runnerIdentity({ WEAVER_RUNNER_ID: '' }, 'host'), /WEAVER_RUNNER_ID.*1-128/);
  assert.throws(() => runnerIdentity({ WEAVER_RUNNER_ID: ' mac ' }, 'host'), /WEAVER_RUNNER_ID.*matching/);
  assert.throws(
    () => runnerClaimIdentity({ WEAVER_RUNNER_PLACEMENT_ONLY: 'yes', WEAVER_RUNNER_ID: 'mac' }, 'host'),
    /WEAVER_RUNNER_PLACEMENT_ONLY must be 0 or 1/,
  );
  assert.throws(
    () => runnerClaimIdentity({ WEAVER_RUNNER_PLACEMENT_ONLY: '1' }, 'host'),
    /requires an explicit nonempty WEAVER_RUNNER_ID/,
  );
});

test('placement-only posture ignores unplaced work while the normal posture remains compatible', () => {
  const normal = runnerClaimIdentity({ WEAVER_RUNNER_ID: 'mac' }, 'host');
  const narrow = runnerClaimIdentity({ WEAVER_RUNNER_ID: 'mac', WEAVER_RUNNER_PLACEMENT_ONLY: '1' }, 'host');
  assert.equal(assignmentMatchesRunner(assignment(), normal), true);
  assert.equal(assignmentMatchesRunner(assignment('mac'), normal), true);
  assert.equal(assignmentMatchesRunner(assignment('gcp'), normal), false);
  assert.equal(assignmentMatchesRunner(assignment(), narrow), false);
  assert.equal(assignmentMatchesRunner(assignment('mac'), narrow), true);
});
