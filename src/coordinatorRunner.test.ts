import assert from 'node:assert/strict';
import { test } from 'node:test';
import { coordinatorRunnerEligibility, liveRunnerIds, validateCoordinatorRunnerOrder } from './coordinatorRunner.js';
import { initialDoc } from './store/doc.js';

function doc(order?: string[]) {
  return initialDoc({
    slug: 'runner-policy', title: 'Runner policy', objective: 'choose one coordinator host',
    tags: [], successCriteria: [], constraints: [], autonomy: { sendsRequireApproval: true },
    ...(order ? { executionPolicy: { coordinatorRunnerOrder: order } } : {}),
  });
}

test('durable coordinator runner order selects the first live host and fails over after TTL', () => {
  const now = Date.parse('2026-08-29T12:00:00.000Z');
  assert.equal(coordinatorRunnerEligibility(doc(), 'any-runner', [], now).eligible, true);
  assert.equal(coordinatorRunnerEligibility(doc(['mac', 'gcp']), 'mac', [], now).eligible, true);

  const freshMac = [{ runnerId: 'mac', heartbeatAt: new Date(now - 30_000).toISOString() }];
  const blocked = coordinatorRunnerEligibility(doc(['mac', 'gcp']), 'gcp', freshMac, now);
  assert.equal(blocked.eligible, false);
  assert.equal(blocked.preferredLiveRunner, 'mac');

  const staleMac = [{ runnerId: 'mac', heartbeatAt: new Date(now - 120_001).toISOString() }];
  assert.equal(coordinatorRunnerEligibility(doc(['mac', 'gcp']), 'gcp', staleMac, now).eligible, true);
  assert.equal(coordinatorRunnerEligibility(doc(['mac', 'gcp']), 'other', [], now).eligible, false);
  assert.deepEqual(liveRunnerIds([...freshMac, ...staleMac], now), ['mac']);
});

test('coordinator runner order rejects malformed or ambiguous durable policy', () => {
  assert.deepEqual(validateCoordinatorRunnerOrder(['mac', 'gcp']), ['mac', 'gcp']);
  assert.throws(() => validateCoordinatorRunnerOrder([]), /at least one/);
  assert.throws(() => validateCoordinatorRunnerOrder(['mac', 'mac']), /duplicate/);
  assert.throws(() => validateCoordinatorRunnerOrder(['bad runner']), /coordinator runner id/);
});
