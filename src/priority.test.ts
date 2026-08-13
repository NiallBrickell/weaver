/** Slot ordering: priority decides which streams run, fairness decides order. */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { byPriorityThenFairness, priorityRank } from './runner.js';

function order(
  streams: Array<[slug: string, priority: 'high' | 'normal' | 'low' | undefined, lastTicked: number]>,
): string[] {
  const priority = new Map(streams.map(([s, p]) => [s, priorityRank(p)]));
  const lastTicked = new Map(streams.map(([s, , t]) => [s, t]));
  return streams.map(([s]) => s).sort(byPriorityThenFairness(priority, lastTicked));
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
