/**
 * Slot ordering and slot allocation: priority decides which streams run,
 * fairness decides order, and a due high band reserves the budget rather than
 * merely leading the queue.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { allocateSlots, byPriorityThenFairness, durableLastServedMs, priorityRank } from './runner.js';
import type { WorkstreamDoc } from './types.js';

type Stream = [slug: string, priority: 'high' | 'normal' | 'low' | undefined, lastTicked: number];

function order(streams: Stream[]): string[] {
  const priority = new Map(streams.map(([s, p]) => [s, priorityRank(p)]));
  const lastTicked = new Map(streams.map(([s, , t]) => [s, t]));
  return streams.map(([s]) => s).sort(byPriorityThenFairness(priority, lastTicked));
}

/** Sort then allocate — the two steps the runner performs on each iteration,
 * including the least-recently-ticked fairness order the floor rotates on. */
function grant(streams: Stream[], cap: number): string[] {
  const priority = new Map(streams.map(([s, p]) => [s, priorityRank(p)]));
  const fairnessDue = [...streams].sort((a, b) => a[2] - b[2]).map(([s]) => s);
  return allocateSlots(order(streams), priority, cap, fairnessDue);
}

/** Background streams nobody ranked, oldest-ticked (so first in line) first. */
function background(count: number, priority: 'normal' | 'low' = 'normal'): Stream[] {
  return Array.from({ length: count }, (_, i) => [`sweep-${i}`, priority, i] as Stream);
}

test('a high-priority stream takes the slot even when it just ran', () => {
  assert.deepEqual(
    order([
      ['sentry-sweep', 'normal', 1],   // waiting longest
      ['evals-health', 'normal', 2],
      ['nobe-parc', 'high', 999],      // ticked most recently, still goes first
    ]),
    ['nobe-parc', 'sentry-sweep', 'evals-health'],
  );
});

test('within a priority the old least-recently-ticked fairness is untouched', () => {
  assert.deepEqual(
    order([
      ['b', 'high', 20],
      ['a', 'high', 10],
      ['c', 'high', 30],
    ]),
    ['a', 'b', 'c'],
  );
});

test('an unset priority is normal, so nothing changes for streams nobody ranked', () => {
  assert.equal(priorityRank(undefined), priorityRank('normal'));
  assert.deepEqual(
    order([['later', undefined, 50], ['earlier', undefined, 5]]),
    ['earlier', 'later'],
  );
});

test('low sits below normal but still runs — it is a ranking, not a pause', () => {
  const ranked = order([
    ['deprioritized', 'low', 1],
    ['ordinary', 'normal', 900],
    ['urgent', 'high', 900],
  ]);
  assert.deepEqual(ranked, ['urgent', 'ordinary', 'deprioritized']);
  assert.equal(ranked.length, 3); // present in the queue, not excluded from it
});

test('a due high stream reserves the budget instead of sharing it with every backstop poll', () => {
  // The live case: one ranked client stream against nineteen sweeps, ten
  // slots. Leading the queue got it one slot and the sweeps took the other
  // nine, so its own work ran on a machine nine ticks were competing for.
  const granted = grant([['nobe-parc-feedback', 'high', 999], ...background(19)], 10);
  assert.ok(granted.includes('nobe-parc-feedback'), 'the ranked stream must get a slot');
  assert.equal(
    granted.filter((s) => s !== 'nobe-parc-feedback').length,
    2,
    'the rest of the fleet gets the floor, not the seven slots the high band left unused',
  );
});

test('high work takes the majority of the slots when there is enough of it to fill them', () => {
  const granted = grant([
    ...Array.from({ length: 10 }, (_, i) => [`client-${i}`, 'high', i] as Stream),
    ...background(10),
  ], 10);
  assert.equal(granted.length, 10, 'a full budget is still fully granted');
  assert.equal(granted.filter((s) => s.startsWith('client-')).length, 8);
  assert.equal(granted.filter((s) => s.startsWith('sweep-')).length, 2);
});

test('the fleet keeps its floor, so a long-running high band can never freeze the rest', () => {
  // More high streams than slots is the case where a reservation could starve
  // everything else permanently — the floor is what stops it.
  const granted = grant([
    ...Array.from({ length: 12 }, (_, i) => [`client-${i}`, 'high', i] as Stream),
    ...background(4, 'low'),
  ], 10);
  assert.equal(granted.filter((s) => s.startsWith('sweep-')).length, 2, 'low still progresses');
  assert.ok(granted.includes('sweep-0'), 'and the floor goes to whoever has waited longest');
});

test('with nothing ranked high, priority leads the head and the floor rotates by age', () => {
  // Formerly the take was pure priority order, which is how a saturated
  // 'normal' band starved 'low' forever (the 2026-08-18 quiet-routines
  // incident). Now the head is still priority-ordered, but the last cap/4
  // slots go to the least-recently-ticked due streams whatever their band.
  const fleet: Stream[] = [...background(12), ['deprioritized', 'low', 0], ['unranked', undefined, 3]];
  const granted = grant(fleet, 10);
  assert.deepEqual(granted.slice(0, 8), order(fleet).slice(0, 8), 'the head is still priority-then-fairness');
  assert.ok(granted.includes('deprioritized'), 'the oldest low stream rotates through the floor');
  assert.equal(granted.length, 10);
  assert.deepEqual(grant(background(4), 10), order(background(4)), 'an unsaturated fleet all runs');
});

test('fairness still decides who goes within a band the reservation is filling', () => {
  const granted = grant([
    ['client-recent', 'high', 900],
    ['client-waiting', 'high', 1],
    ['client-middle', 'high', 400],
    ...background(6),
  ], 4);
  // Cap 4 reserves 3 for high; least-recently-ticked decides which 3, and the
  // single floor slot goes to the sweep that has waited longest.
  assert.deepEqual(granted, ['client-waiting', 'client-middle', 'client-recent', 'sweep-0']);
});

test('a cap too small to partition degrades to the ranking, which is what the human asked for', () => {
  const fleet: Stream[] = [['urgent', 'high', 999], ...background(5)];
  assert.deepEqual(grant(fleet, 1), ['urgent'], 'the only slot follows the ranking');
  assert.deepEqual(grant(fleet, 2), ['urgent', 'sweep-0'], 'two slots split one each');
  assert.deepEqual(grant(fleet, 0), [], 'no budget grants nothing rather than one of everything');
});

test('a saturated normal band cannot starve the low band — the floor rotates by age', () => {
  // The live case (2026-08-18): eleven busy 'normal' streams against ten (or
  // load-throttled fewer) slots, all evening. The 'low' routines — the sentry
  // sweep, the daily update, thread-review — were never ticked at all, and a
  // crashed action sat unrecovered for hours with zero telemetry.
  const normals: Stream[] = Array.from({ length: 11 }, (_, i) => [`busy-${i}`, 'normal', 100 + i] as Stream);
  const granted = grant([...normals, ['sentry-sweep', 'low', 1]], 8);
  assert.ok(
    granted.includes('sentry-sweep'),
    'the least-recently-ticked low stream must rotate through the fairness floor',
  );
  assert.equal(granted.length, 8);
});

test('when everyone fits, no floor arithmetic changes anything', () => {
  const granted = grant([['a', 'normal', 2], ['b', 'low', 1]], 5);
  assert.deepEqual([...granted].sort(), ['a', 'b']);
});


test('fairness survives a restart: the stream served longest ago goes first, not the first slug', () => {
  // A fresh runner has no memory of ticks. Seeding from the documents' own
  // pass/attempt starts keeps least-recently-served order instead of letting
  // the store's alphabetical slug order decide who runs after every restart.
  const doc = (passStarts: string[], attemptStarts: string[] = []) => ({
    passes: passStarts.map((startedAt) => ({ startedAt })),
    assignments: attemptStarts.length ? [{ attempts: attemptStarts.map((startedAt) => ({ startedAt })) }] : [],
  }) as unknown as WorkstreamDoc;
  const served = new Map<string, number>([
    ['daily-engineering-update', durableLastServedMs(doc(['2026-09-21T14:40:00Z']))],
    ['evals-health', durableLastServedMs(doc(['2026-09-21T13:30:00Z']))],
    // Last pass on the 17th, but a worker attempt started on the 20th.
    ['support-intake-routine', durableLastServedMs(doc(['2026-09-17T09:00:00Z'], ['2026-09-20T09:00:00Z']))],
    ['thread-review-c15-agent-sql-composition', durableLastServedMs(doc(['2026-09-17T22:20:06Z']))],
  ]);
  const priority = new Map([...served.keys()].map((slug) => [slug, priorityRank('normal')]));
  const alphabetical = [...served.keys()].sort();
  assert.deepEqual(
    alphabetical.sort(byPriorityThenFairness(priority, served)),
    ['thread-review-c15-agent-sql-composition', 'support-intake-routine', 'evals-health', 'daily-engineering-update'],
  );
  assert.equal(durableLastServedMs(doc([])), 0, 'a stream never served ranks first');
});
