/** The needs-you queue's order: urgency first, then longest waiting. */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { compareNeedsYou } from './tui.js';

type Item = Parameters<typeof compareNeedsYou>[0];

function item(over: Partial<Item> & Pick<Item, 'key' | 'rank'>): Item {
  return {
    slug: 'ws',
    kind: 'attention',
    refId: 'ref',
    title: 't',
    body: 'b',
    ...over,
  } as Item;
}

test('a blocker outranks an approval, which outranks a review', () => {
  const review = item({ key: 'review', rank: 2, slug: 'aaa-first-alphabetically' });
  const approval = item({ key: 'approval', rank: 1, slug: 'mmm' });
  const blocker = item({ key: 'blocker', rank: 0, slug: 'zzz-last-alphabetically' });
  const ordered = [review, approval, blocker].sort(compareNeedsYou).map((i) => i.key);
  assert.deepEqual(ordered, ['blocker', 'approval', 'review']);
});

test('within a rank the oldest is answered first, and an undated item waits its turn last', () => {
  const newer = item({ key: 'newer', rank: 1, at: '2026-06-02T00:00:00.000Z', slug: 'aaa' });
  const older = item({ key: 'older', rank: 1, at: '2026-06-01T00:00:00.000Z', slug: 'zzz' });
  const undated = item({ key: 'undated', rank: 1, slug: 'bbb' });
  const ordered = [undated, newer, older].sort(compareNeedsYou).map((i) => i.key);
  assert.deepEqual(ordered, ['older', 'newer', 'undated']);
});

test('the slug is the last tiebreak, so the queue does not shuffle between polls', () => {
  const a = item({ key: 'a', rank: 1, at: '2026-06-01T00:00:00.000Z', slug: 'alpha' });
  const b = item({ key: 'b', rank: 1, at: '2026-06-01T00:00:00.000Z', slug: 'beta' });
  assert.ok(compareNeedsYou(a, b) < 0);
  assert.ok(compareNeedsYou(b, a) > 0);
  assert.equal(compareNeedsYou(a, a), 0);
});
