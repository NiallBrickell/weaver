/** The fleet capacity ledger: one account's limits, recovered once for all. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  noteFleetRecovery,
  readFleetCapacity,
  supersededByFleetRecovery,
} from './fleetCapacity.js';
import { coordinatorCapacityTarget, workerCapacityTarget } from './modelConfig.js';

/** Each test owns its own WEAVER_HOME so the ledger is never shared. */
function inHome<T>(fn: () => T): T {
  const previous = process.env.WEAVER_HOME;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'weaver-fleet-capacity-'));
  process.env.WEAVER_HOME = dir;
  try {
    return fn();
  } finally {
    if (previous === undefined) delete process.env.WEAVER_HOME;
    else process.env.WEAVER_HOME = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('one streams success releases another streams park on the same pool', () => {
  inHome(() => {
    const target = coordinatorCapacityTarget('claude-opus-5');
    const parkedAt = '2026-08-13T13:02:00.000Z';
    assert.equal(supersededByFleetRecovery(readFleetCapacity(), target, parkedAt), false);

    noteFleetRecovery(target, '2026-08-13T14:08:00.000Z');
    assert.equal(supersededByFleetRecovery(readFleetCapacity(), target, parkedAt), true);
  });
});

test('a limit recorded AFTER the recovery still holds — this is what stops a loop', () => {
  inHome(() => {
    const target = coordinatorCapacityTarget('claude-opus-5');
    noteFleetRecovery(target, '2026-08-13T14:08:00.000Z');
    // A pass that ran later and was rejected: its own detection is the newer
    // fact, so the stale recovery must not release it.
    assert.equal(
      supersededByFleetRecovery(readFleetCapacity(), target, '2026-08-13T14:20:00.000Z'),
      false,
    );
  });
});

test('recovery is per target — a worker pool never releases a coordinator pool', () => {
  inHome(() => {
    const worker = workerCapacityTarget('sonnet', 'local-sdk');
    const coordinator = coordinatorCapacityTarget('claude-opus-5');
    noteFleetRecovery(worker, '2026-08-13T14:08:00.000Z');
    const ledger = readFleetCapacity();
    assert.equal(supersededByFleetRecovery(ledger, worker, '2026-08-13T13:00:00.000Z'), true);
    assert.equal(supersededByFleetRecovery(ledger, coordinator, '2026-08-13T13:00:00.000Z'), false);
  });
});

test('recovery only moves forward, so a slow writer cannot resurrect cleared parks', () => {
  inHome(() => {
    const target = coordinatorCapacityTarget('claude-opus-5');
    noteFleetRecovery(target, '2026-08-13T14:08:00.000Z');
    noteFleetRecovery(target, '2026-08-13T13:00:00.000Z'); // finished late, observed earlier
    assert.equal(readFleetCapacity().recovered['local-sdk:anthropic:claude-opus-5'], '2026-08-13T14:08:00.000Z');
  });
});

test('an absent or corrupt ledger means no recovery is known, never a false release', () => {
  inHome(() => {
    const target = coordinatorCapacityTarget('claude-opus-5');
    assert.deepEqual(readFleetCapacity(), { recovered: {} });

    fs.writeFileSync(path.join(process.env.WEAVER_HOME!, 'capacity.json'), '{ not json');
    assert.deepEqual(readFleetCapacity(), { recovered: {} });

    // A hand-edited entry that is not a usable timestamp is dropped, not trusted.
    fs.writeFileSync(
      path.join(process.env.WEAVER_HOME!, 'capacity.json'),
      JSON.stringify({ recovered: { 'local-sdk:anthropic:claude-opus-5': 'whenever' } }),
    );
    assert.equal(supersededByFleetRecovery(readFleetCapacity(), target, '2026-08-13T13:00:00.000Z'), false);
  });
});
