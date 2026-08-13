/** How a fleet row renders a capacity park: stalled must not read as scheduled. */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { streamDecoration } from './tui.js';

type Row = Parameters<typeof streamDecoration>[0];

function row(over: Partial<Row> = {}): Row {
  return { bucket: 2, queuedNow: false, paused: false, ...over };
}

test('a capacity park never wears the same badge as a scheduled wait', () => {
  const scheduled = streamDecoration(row());
  const parked = streamDecoration(row({
    capacityBlock: { summary: 'coordinator Claude session limited · retry in 56m', needsHuman: false },
  }));
  assert.equal(scheduled.word, 'WAITING');
  assert.equal(parked.word, 'LIMITED');
  assert.notEqual(parked.color, scheduled.color);
  assert.notEqual(parked.glyph, scheduled.glyph);
});

test('red only when a person has to act; a self-clearing limit stays yellow', () => {
  const mine = streamDecoration(row({
    capacityBlock: { summary: 'coordinator Claude usage limited · retry in 1h', needsHuman: true },
  }));
  const itself = streamDecoration(row({
    capacityBlock: { summary: 'coordinator Claude session limited · retry in 56m', needsHuman: false },
  }));
  assert.equal(mine.color, 'red');
  assert.equal(itself.color, 'yellow');
  assert.equal(mine.word, itself.word); // both are LIMITED — the colour carries whose move it is
});

test('a park outranks QUEUED and DORMANT, which would both read as progress', () => {
  const block = { summary: 'worker Claude usage limited · retry in 1h', needsHuman: true };
  assert.equal(streamDecoration(row({ queuedNow: true, capacityBlock: block })).word, 'LIMITED');
  assert.equal(streamDecoration(row({ bucket: 3, capacityBlock: block })).word, 'LIMITED');
  // …and without a park those states are untouched.
  assert.equal(streamDecoration(row({ queuedNow: true })).word, 'QUEUED');
  assert.equal(streamDecoration(row({ bucket: 3 })).word, 'DORMANT');
});

test('NEEDS YOU still outranks nothing — a park is not an attention card', () => {
  // Bucket 0 rows carry a human decision; the snapshot never sets a park on
  // one, so the badge must not silently repaint an attention row yellow.
  assert.equal(streamDecoration(row({ bucket: 0 })).word, 'NEEDS YOU');
  assert.equal(streamDecoration(row({ bucket: 1 })).word, 'WORKING');
  assert.equal(streamDecoration(row({ bucket: 3, paused: true })).word, 'IDLE');
});
