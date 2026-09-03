import assert from 'node:assert/strict';
import { test } from 'node:test';
import { recordCapacityBackoff } from './capacity.js';
import { coordinatorRunnerEligibility, liveRunnerIds, validateCoordinatorRunnerOrder } from './coordinatorRunner.js';
import { initialDoc } from './store/doc.js';
import type { InfrastructureWait } from './types.js';

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

test('a live preferred runner whose every published coordinator seat is parked yields the claim', () => {
  const now = Date.parse('2026-09-03T14:00:00.000Z');
  const nowIso = new Date(now).toISOString();
  const fable = { executor: 'local-sdk', provider: 'anthropic', model: 'claude-fable-5' };
  const opus = { executor: 'local-sdk', provider: 'anthropic', model: 'claude-opus-5' };
  const glm = { executor: 'local-sdk', provider: 'openrouter', model: 'openrouter/z-ai/glm-5.3' };
  const codex = { executor: 'codex-sdk', provider: 'openai', model: 'gpt-5.6-sol' };
  const park = (d: ReturnType<typeof doc>, seat: typeof fable, retryAt: string) =>
    recordCapacityBackoff(d, {
      kind: 'usage_limit', recovery: 'wait_or_enable_usage_credits', source: 'coordinator', sourceId: 'pass_x',
      model: seat.model, executor: seat.executor, provider: seat.provider,
      detectedAt: nowIso, retryAt,
    } satisfies InfrastructureWait);

  const fleetSeated = [{ runnerId: 'gcp', heartbeatAt: nowIso, coordinatorSeats: [fable, opus, glm] }];
  const macSeated = [{ runnerId: 'mac', heartbeatAt: nowIso, coordinatorSeats: [fable, opus, codex] }];

  // Nothing parked: the preferred host holds the claim as before.
  const open = doc(['gcp', 'mac']);
  assert.equal(coordinatorRunnerEligibility(open, 'mac', fleetSeated, now).eligible, false);

  // Every seat the preferred host publishes is parked on this Workstream: it
  // is live but cannot launch a pass, so the standby becomes eligible.
  const parked = doc(['gcp', 'mac']);
  park(parked, fable, '2026-09-30T00:00:00.000Z');
  park(parked, opus, '2026-09-03T15:10:00.000Z');
  park(parked, glm, '2026-09-03T14:20:00.000Z');
  assert.equal(coordinatorRunnerEligibility(parked, 'mac', fleetSeated, now).eligible, true);
  // The same parks do not make the standby yield to itself, and a seat the
  // preferred host does not have (Codex) does not count for it.
  assert.equal(coordinatorRunnerEligibility(parked, 'gcp', macSeated, now).eligible, true);

  // A park whose retry has passed is an open seat again: the preferred host
  // reclaims and the standby steps back. The capacity clock is the caller's
  // (virtual) clock, separate from the heartbeat clock.
  const expired = coordinatorRunnerEligibility(parked, 'mac', fleetSeated, now, undefined, '2026-09-03T14:21:00.000Z');
  assert.equal(expired.eligible, false);
  assert.equal(expired.preferredLiveRunner, 'gcp');
  // Sixty seconds on the heartbeat clock alone changes nothing: the preferred
  // host is still live and every park still stands.
  assert.equal(coordinatorRunnerEligibility(parked, 'mac', fleetSeated, now + 60_000).eligible, true);

  // A presence without published seats is liveness alone (runners that
  // predate seat publication), and a runner that publishes zero seats can
  // launch nothing and yields.
  const legacy = [{ runnerId: 'gcp', heartbeatAt: nowIso }];
  assert.equal(coordinatorRunnerEligibility(parked, 'mac', legacy, now).eligible, false);
  const seatless = [{ runnerId: 'gcp', heartbeatAt: nowIso, coordinatorSeats: [] }];
  assert.equal(coordinatorRunnerEligibility(open, 'mac', seatless, now).eligible, true);
});

test('coordinator runner order rejects malformed or ambiguous durable policy', () => {
  assert.deepEqual(validateCoordinatorRunnerOrder(['mac', 'gcp']), ['mac', 'gcp']);
  assert.throws(() => validateCoordinatorRunnerOrder([]), /at least one/);
  assert.throws(() => validateCoordinatorRunnerOrder(['mac', 'mac']), /duplicate/);
  assert.throws(() => validateCoordinatorRunnerOrder(['bad runner']), /coordinator runner id/);
});
