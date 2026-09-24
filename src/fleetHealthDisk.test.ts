/**
 * /healthz/fleet warns about a filling state disk before the runner's own
 * floor stops dispatch — the 2026-09-24 outage had no earlier signal.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FLEET_STATE_FREE_WARN_BYTES, fleetHealthSnapshot } from './operatorUi.js';
import type { RunnerPresence } from './store.js';

const NOW = Date.parse('2026-09-24T09:00:00Z');

function presence(stateFreeBytes: number | undefined, degraded?: string): RunnerPresence {
  return {
    runnerId: 'gcp',
    heartbeatAt: new Date(NOW - 4_000).toISOString(),
    coordinatorSeats: [],
    ...(degraded === undefined ? {} : { degraded }),
    output: {
      observedAt: new Date(NOW - 9_000).toISOString(),
      lastCompletedPassAt: new Date(NOW - 60_000).toISOString(),
      capacityBlocked: 0,
      ...(stateFreeBytes === undefined ? {} : { stateFreeBytes }),
    },
  };
}

test('a healthy runner with room reports its free space and no problem', () => {
  const snapshot = fleetHealthSnapshot([presence(160 * 1024 ** 3)], NOW);
  assert.equal(snapshot.state_free_mib, 160 * 1024);
  assert.deepEqual(snapshot.problems, []);
  assert.equal(snapshot.unhealthy, 0);
});

test('under the 2 GiB warning line the fleet is unhealthy while the runner still dispatches', () => {
  const snapshot = fleetHealthSnapshot([presence(FLEET_STATE_FREE_WARN_BYTES - 1)], NOW);
  assert.equal(snapshot.state_free_mib, 2048);
  assert.deepEqual(snapshot.problems, [
    "the runner's state filesystem has 2048 MiB free, under the 2 GiB warning line; below 512 MiB it stops dispatching",
  ]);
  assert.equal(snapshot.unhealthy, 1);
  assert.equal(snapshot.healthy_runners, 1, 'the runner itself is still healthy: this is the early warning');
});

test('a runner that predates the field, or is degraded, publishes no free-space figure', () => {
  assert.equal(fleetHealthSnapshot([presence(undefined)], NOW).state_free_mib, null);
  const degraded = fleetHealthSnapshot([presence(100 * 1024 ** 2, 'state directory has 100 MiB free')], NOW);
  // The degraded presence's cached output is not evidence of current state;
  // the degraded condition itself already marks the fleet unhealthy.
  assert.equal(degraded.state_free_mib, null);
  assert.equal(degraded.unhealthy, 1);
});
